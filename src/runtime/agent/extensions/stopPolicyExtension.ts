/**
 * 单轮停止策略：重复失败熔断、工具轮数上限和连续空参保护。
 *
 * 空参与重复失败共用「先引导、后熔断」语义：达到阈值先注入恢复指令给模型
 * 一次自愈机会，引导后仍重犯才中断，避免弱实现一次抖动就打断任务。
 *
 * 失败状态在整个 batch 完成后按调用源顺序更新，避免并行完成时序改变连续性判定。
 */
import { createHash } from 'crypto'
import type { ShouldStopArgs, StopDecision } from '../core/loopTypes'

/** 同一签名工具调用累计失败达到该次数时注入恢复指令。 */
export const REPEATED_FAILURE_LIMIT = 3

/** 连续全空参轮次达到该次数时注入恢复指令；引导后下一轮仍全空参才中断 */
export const EMPTY_ARGS_LIMIT = 2

/**
 * 停止通知的受众。primary 面向主会话人类（含「发送继续」「设置」等操作指引）；
 * subagent 的通知会经最终 assistant 消息成为父代理读到的摘要，不得包含
 * 面向人类的指引。
 */
export type StopNoticeAudience = 'primary' | 'subagent'

/** 停止策略扩展。持有当前失败签名与空参轮次状态。 */
export class StopPolicyExtension {
  private readonly audience: StopNoticeAudience

  constructor(options: { audience?: StopNoticeAudience } = {}) {
    this.audience = options.audience ?? 'primary'
  }

  private readonly repeatedFailures = new Map<string, {
    toolName: string
    count: number
    recoveryIssued: boolean
  }>()
  /** 连续「本轮所有 tool_calls 参数均为空」的轮次计数 */
  private emptyArgsRoundCount = 0
  /** 空参恢复指令已注入；其后首个再犯轮次熔断 */
  private emptyArgsRecoveryIssued = false

  /** 每条用户消息开始时清空轮次级计数。 */
  clear(): void {
    this.repeatedFailures.clear()
    this.emptyArgsRoundCount = 0
    this.emptyArgsRecoveryIssued = false
  }

  /** 返回停止决定；没有命中保护条件时继续下一轮。 */
  async shouldStopAfterTurn(args: ShouldStopArgs): Promise<StopDecision | void> {
    const emptyArgsDecision = this.trackEmptyArgsRounds(args)
    if (emptyArgsDecision?.stop) return emptyArgsDecision

    const repeatedFailure = this.trackRepeatedFailures(args.outcomes)
    if (repeatedFailure?.action === 'stop') {
      const notice = this.audience === 'subagent'
        ? `\n\n[已自动中断] 对「${repeatedFailure.toolName}」的相同失败调用在恢复提示后仍被重复，` +
          `已停止本轮以避免无效循环。失败原因见上方的工具错误信息。`
        : `\n\n[已自动中断] 对「${repeatedFailure.toolName}」的相同失败调用在恢复提示后仍被重复，` +
          `已停止本轮以避免无效循环。` +
          `请查看上方的工具错误信息后再调整指令。`
      return { stop: true, reason: 'breaker', notice }
    }

    if (args.toolRound >= args.maxToolRounds) {
      const notice = this.audience === 'subagent'
        ? `\n\n[已达到最大工具调用轮数 ${args.maxToolRounds}] ` +
          `任务尚未完成，以上为截断前的执行进展；` +
          `如需继续，请由调用方以更窄的范围重新派遣子任务。`
        : `\n\n[已达到最大工具调用轮数 ${args.maxToolRounds}] ` +
          `任务可能尚未完成，已暂停以避免无限循环。` +
          `发送「继续」可接着执行；如长任务频繁触发，可在「设置 → 通用 → 最大工具调用轮数」中调大该上限。`
      return { stop: true, reason: 'max_rounds', notice }
    }
    // 空参引导比通用重复失败引导更具体，同轮同时命中时优先下发。
    if (emptyArgsDecision) return emptyArgsDecision
    if (repeatedFailure?.action === 'recover') {
      return {
        stop: false,
        instruction:
          `[Runtime guard] The same "${repeatedFailure.toolName}" call failed ` +
          `${REPEATED_FAILURE_LIMIT} times with equivalent arguments. Do not submit it ` +
          `unchanged again. Read the latest error and continue with a different approach: ` +
          `fix prerequisites, change the arguments, or use another tool.`
      }
    }
  }

  /**
   * 统计连续「本轮所有 tool_calls 在 repair 后仍为空参」的轮次。
   * 中间出现非空参或任一工具成功执行则连同引导状态一起清零。
   * 达到阈值先注入恢复指令给模型一次补参机会；引导后仍全空参才中断。
   */
  private trackEmptyArgsRounds(args: ShouldStopArgs): StopDecision | null {
    const roundCalls = args.toolCallsThisRound ?? []
    if (roundCalls.length === 0) return null

    // 任一工具成功 → 清零（说明 native 通道可用）
    const hasSuccess = args.outcomes.some(
      o => !o.skippedByAbort && o.failed !== true
    )
    if (hasSuccess || !roundCalls.every(tc => isEmptyArgsRecord(tc.args))) {
      this.emptyArgsRoundCount = 0
      this.emptyArgsRecoveryIssued = false
      return null
    }

    this.emptyArgsRoundCount++
    if (this.emptyArgsRoundCount < EMPTY_ARGS_LIMIT) return null

    if (this.emptyArgsRecoveryIssued) {
      const notice = this.audience === 'subagent'
        ? `\n\n[已自动中断] 模型在空参恢复提示后仍返回空工具参数，已停止本轮以避免空转。`
        : `\n\n[已自动中断] 模型在空参恢复提示后仍返回空工具参数，已停止本轮以避免空转。` +
          `可在「设置 → LLM 配置 → 工具调用方式」改为 XML 兼容模式后重试。`
      return { stop: true, reason: 'empty_args', notice }
    }

    this.emptyArgsRecoveryIssued = true
    return {
      stop: false,
      instruction:
        `[Runtime guard] Your tool calls in the last round had empty arguments, ` +
        `so every call failed. Do not resubmit them with empty arguments. Re-read ` +
        `each tool's parameter schema and provide the complete arguments as valid ` +
        `JSON in your next tool call.`
    }
  }

  /**
   * 按签名跟踪语义等价的失败调用。达到阈值时先给模型一次改变路径的机会；
   * 若下一轮仍提交同一失败调用，再终止当前轮次。
   */
  private trackRepeatedFailures(
    outcomes: Array<{
      toolCall: { id: string; name: string }
      args: Record<string, unknown>
      resultText: string
      failed?: boolean
      skippedByAbort?: boolean
    }>
  ): { toolName: string; action: 'recover' | 'stop' } | null {
    const decisions = new Map<string, { toolName: string; action: 'recover' | 'stop' }>()
    const failureOrder: string[] = []
    const recoveredBeforeRound = new Set(
      [...this.repeatedFailures.entries()]
        .filter(([, state]) => state.recoveryIssued)
        .map(([signature]) => signature)
    )

    for (const outcome of outcomes) {
      if (outcome.skippedByAbort) continue

      const signature = buildFailureSignature(outcome.toolCall.name, outcome.args)
      if (outcome.failed !== true) {
        this.repeatedFailures.delete(signature)
        decisions.delete(signature)
        continue
      }

      if (!failureOrder.includes(signature)) failureOrder.push(signature)
      let repeatedFailure = this.repeatedFailures.get(signature)
      if (!repeatedFailure) {
        repeatedFailure = {
          toolName: outcome.toolCall.name,
          count: 1,
          recoveryIssued: false
        }
        this.repeatedFailures.set(signature, repeatedFailure)
        continue
      }

      repeatedFailure.count += 1
      if (repeatedFailure.recoveryIssued) {
        decisions.set(signature, {
          toolName: outcome.toolCall.name,
          action: recoveredBeforeRound.has(signature) ? 'stop' : 'recover'
        })
        continue
      }
      if (repeatedFailure.count >= REPEATED_FAILURE_LIMIT) {
        repeatedFailure.recoveryIssued = true
        decisions.set(signature, { toolName: outcome.toolCall.name, action: 'recover' })
      }
    }

    for (const signature of failureOrder) {
      const decision = decisions.get(signature)
      if (decision) return decision
    }
    return null
  }
}

function buildFailureSignature(toolName: string, args: Record<string, unknown>): string {
  let argsKey: string
  try {
    const serialized = JSON.stringify(sortObjectKeys(args))
    argsKey = typeof serialized === 'string' ? serialized : String(serialized)
  } catch {
    argsKey = String(args)
  }
  const digest = createHash('sha256').update(argsKey).digest('hex')
  return `${toolName}:${digest}`
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys)
  if (typeof value !== 'object' || value === null) return value

  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map(key => [key, sortObjectKeys(record[key])])
  )
}

/** 判断参数对象是否为空（{} 或无有效字段） */
function isEmptyArgsRecord(args: Record<string, unknown>): boolean {
  return Object.keys(args).length === 0
}
