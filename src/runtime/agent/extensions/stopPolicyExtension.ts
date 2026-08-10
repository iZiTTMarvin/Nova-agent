/**
 * 单轮停止策略：重复失败熔断、工具轮数上限和连续空参保护。
 *
 * 失败状态在整个 batch 完成后按调用源顺序更新，避免并行完成时序改变连续性判定。
 */
import { createHash } from 'crypto'
import type { ShouldStopArgs, StopDecision } from '../core/loopTypes'

/** 同一签名工具调用累计失败达到该次数时注入恢复指令。 */
export const REPEATED_FAILURE_LIMIT = 3

/** 连续全空参轮次达到该次数即中断，避免 native 弱实现空转 */
export const EMPTY_ARGS_LIMIT = 2

/** 停止策略扩展。持有当前失败签名与空参轮次状态。 */
export class StopPolicyExtension {
  private readonly repeatedFailures = new Map<string, {
    toolName: string
    count: number
    recoveryIssued: boolean
  }>()
  /** 连续「本轮所有 tool_calls 参数均为空」的轮次计数 */
  private emptyArgsRoundCount = 0

  /** 每条用户消息开始时清空轮次级计数。 */
  clear(): void {
    this.repeatedFailures.clear()
    this.emptyArgsRoundCount = 0
  }

  /** 返回停止决定；没有命中保护条件时继续下一轮。 */
  async shouldStopAfterTurn(args: ShouldStopArgs): Promise<StopDecision | void> {
    const emptyArgsStop = this.trackEmptyArgsRounds(args)
    if (emptyArgsStop) return emptyArgsStop

    const repeatedFailure = this.trackRepeatedFailures(args.outcomes)
    if (repeatedFailure?.action === 'stop') {
      const notice =
        `\n\n[已自动中断] 对「${repeatedFailure.toolName}」的相同失败调用在恢复提示后仍被重复，` +
        `已停止本轮以避免无效循环。` +
        `请查看上方的工具错误信息后再调整指令。`
      return { stop: true, reason: 'breaker', notice }
    }

    if (args.toolRound >= args.maxToolRounds) {
      const notice =
        `\n\n[已达到最大工具调用轮数 ${args.maxToolRounds}] ` +
        `任务可能尚未完成，已暂停以避免无限循环。` +
        `发送「继续」可接着执行；如长任务频繁触发，可在「设置 → 通用 → 最大工具调用轮数」中调大该上限。`
      return { stop: true, reason: 'max_rounds', notice }
    }
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
   * 中间出现非空参或任一工具成功执行则清零。
   */
  private trackEmptyArgsRounds(args: ShouldStopArgs): StopDecision | null {
    const roundCalls = args.toolCallsThisRound ?? []
    if (roundCalls.length === 0) return null

    // 任一工具成功 → 清零（说明 native 通道可用）
    const hasSuccess = args.outcomes.some(
      o => !o.skippedByAbort && o.failed !== true
    )
    if (hasSuccess) {
      this.emptyArgsRoundCount = 0
      return null
    }

    const allEmpty = roundCalls.every(tc => isEmptyArgsRecord(tc.args))
    if (!allEmpty) {
      this.emptyArgsRoundCount = 0
      return null
    }

    this.emptyArgsRoundCount++
    if (this.emptyArgsRoundCount < EMPTY_ARGS_LIMIT) return null

    const notice =
      `\n\n[已自动中断] 模型连续多轮返回空工具参数，已停止本轮以避免空转。` +
      `可在「设置 → LLM 配置 → 工具调用方式」改为 XML 兼容模式后重试。`
    return { stop: true, reason: 'empty_args', notice }
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
