/**
 * 单轮停止策略：循环检测、轮数上限和连续空参保护。
 *
 * 主会话没有固定轮数上限，靠「有没有进展」判断要不要停：
 * - 重复失败熔断：同一签名反复失败。
 * - 重复成功调用：同一签名反复成功（反复读同一个文件这类原地打转）。
 * - 长时间无进展：连续多轮没有出现过本轮没见过且成功的调用。
 * 后两类命中先注入恢复指令让模型换路径，再犯才请用户裁决，不静默停止。
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

/** 同一签名连续成功达到该次数时判定为原地打转。 */
export const REPEATED_SUCCESS_LIMIT = 5

/** 连续这么多轮没有出现新的成功调用时判定为无进展。 */
export const NO_PROGRESS_ROUND_LIMIT = 20

/** 主会话每隔这么多轮做一次目标自检（只注入指令，不停止）。 */
export const SELF_CHECK_ROUND_INTERVAL = 100

/**
 * 停止通知的受众。primary 面向主会话人类（含「发送继续」「设置」等操作指引）；
 * subagent 的通知会经最终 assistant 消息成为父代理读到的摘要，不得包含
 * 面向人类的指引。
 */
export type StopNoticeAudience = 'primary' | 'subagent'

/** 命中循环检测时向用户追问的原因 */
export type NoProgressKind = 'repeated_call' | 'no_progress'

/** 用户裁决结果：换思路继续 / 本轮不再提醒 / 停止 */
export type NoProgressChoice = 'redirect' | 'silence' | 'stop'

/** 循环检测请用户裁决的通道；未装配时命中即停止（子代理、headless）。 */
export type NoProgressAdjudicator = (
  request: { kind: NoProgressKind; toolName?: string; rounds: number }
) => Promise<NoProgressChoice>

/** 停止策略扩展。持有循环检测、失败签名与空参轮次状态。 */
export class StopPolicyExtension {
  private readonly audience: StopNoticeAudience
  private readonly adjudicate: NoProgressAdjudicator | undefined
  /** 由工具自己声明等待语义，kernel 不认识具体工具名 */
  private readonly isProgressNeutral: ((name: string, args: Record<string, unknown>) => boolean) | undefined

  constructor(options: {
    audience?: StopNoticeAudience
    adjudicateNoProgress?: NoProgressAdjudicator
    isProgressNeutralTool?: (name: string, args: Record<string, unknown>) => boolean
  } = {}) {
    this.audience = options.audience ?? 'primary'
    this.adjudicate = options.adjudicateNoProgress
    this.isProgressNeutral = options.isProgressNeutralTool
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

  /** 本轮已成功过的调用签名：出现新签名才算有进展 */
  private readonly seenSignatures = new Set<string>()
  /** 连续无新进展的轮数（中性轮不推进） */
  private roundsWithoutProgress = 0
  /** 连续单签名成功次数，用于识别原地打转 */
  private repeatedSuccessCount = 0
  private lastSuccessSignature: string | null = null
  private lastSuccessToolName: string | null = null
  /** 循环恢复指令已注入过：再命中就交给用户裁决 */
  private loopRecoveryIssued: NoProgressKind | null = null
  /** 用户选择「本轮不再提醒」后不再打断 */
  private silenced = false
  private lastSelfCheckRound = 0

  /** 每条用户消息开始时清空轮次级计数。 */
  clear(): void {
    this.repeatedFailures.clear()
    this.emptyArgsRoundCount = 0
    this.emptyArgsRecoveryIssued = false
    this.seenSignatures.clear()
    this.roundsWithoutProgress = 0
    this.repeatedSuccessCount = 0
    this.lastSuccessSignature = null
    this.lastSuccessToolName = null
    this.loopRecoveryIssued = null
    this.silenced = false
    this.lastSelfCheckRound = 0
  }

  /** 返回停止决定；没有命中保护条件时继续下一轮。 */
  async shouldStopAfterTurn(args: ShouldStopArgs): Promise<StopDecision | void> {
    const emptyArgsDecision = this.trackEmptyArgsRounds(args)
    if (emptyArgsDecision?.stop) return emptyArgsDecision

    const repeatedFailure = this.trackRepeatedFailures(args.outcomes)
    if (repeatedFailure?.action === 'stop') {
      return { stop: true, reason: 'breaker', notice: this.breakerNotice(repeatedFailure.toolName) }
    }

    if (args.maxToolRounds !== null && args.toolRound >= args.maxToolRounds) {
      return { stop: true, reason: 'max_rounds', notice: this.maxRoundsNotice(args.maxToolRounds) }
    }

    const loopDecision = await this.trackProgress(args)
    if (loopDecision?.stop) return loopDecision
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
    if (loopDecision) return loopDecision

    const selfCheck = this.takeSelfCheck(args.toolRound)
    if (selfCheck) return selfCheck
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
   * 循环检测：更新进展窗口后判定是否原地打转或长期无进展。
   * 第一次命中注入恢复指令；再次命中请用户裁决，没有裁决通道才停止。
   */
  private async trackProgress(args: ShouldStopArgs): Promise<StopDecision | null> {
    if (this.silenced) return null

    const effective = args.outcomes.filter(o => !o.skippedByAbort && !this.isNeutral(o.toolCall.name, o.args))
    if (effective.length === 0) return null
    const successful = effective.filter(o => o.failed !== true)
    const signatures = successful.map(o => buildFailureSignature(o.toolCall.name, o.args))
    const fresh = signatures.filter(s => !this.seenSignatures.has(s))
    for (const s of signatures) this.seenSignatures.add(s)

    if (fresh.length > 0) {
      this.roundsWithoutProgress = 0
      const single = signatures.length === 1 ? signatures[0] : null
      this.repeatedSuccessCount = 1
      this.lastSuccessSignature = single
      this.lastSuccessToolName = single !== null ? successful[0].toolCall.name : null
      // 有实质进展就撤销上一次循环恢复的状态，允许模型在同一路径上继续推进
      this.loopRecoveryIssued = null
      return null
    }

    this.roundsWithoutProgress += 1
    if (this.lastSuccessSignature !== null && signatures.includes(this.lastSuccessSignature)) {
      this.repeatedSuccessCount += 1
    } else {
      this.repeatedSuccessCount = 1
      this.lastSuccessSignature = signatures.length === 1 ? signatures[0] : null
      this.lastSuccessToolName = this.lastSuccessSignature !== null ? successful[0].toolCall.name : null
    }
    return this.decideLoop(args.toolRound)
  }

  /** 命中循环阈值后：首次注入恢复指令，再次命中请用户裁决。 */
  private async decideLoop(toolRound: number): Promise<StopDecision | null> {
    const repeated = this.repeatedSuccessCount > REPEATED_SUCCESS_LIMIT
    const stalled = this.roundsWithoutProgress >= NO_PROGRESS_ROUND_LIMIT
    if (!repeated && !stalled) return null

    const kind: NoProgressKind = repeated ? 'repeated_call' : 'no_progress'
    const toolName = repeated ? this.lastSuccessToolName ?? undefined : undefined
    if (this.loopRecoveryIssued === null) {
      this.loopRecoveryIssued = kind
      return { stop: false, instruction: this.loopRecoveryInstruction(kind, toolName) }
    }

    const choice = await this.adjudicate?.({ kind, ...(toolName ? { toolName } : {}), rounds: toolRound })
    if (choice === undefined || choice === 'stop') {
      return { stop: true, reason: 'no_progress', notice: this.noProgressNotice(kind) }
    }
    this.resetProgressWindow()
    if (choice === 'silence') {
      this.silenced = true
      return null
    }
    return { stop: false, instruction: this.loopRecoveryInstruction(kind, toolName) }
  }

  /** 用户裁决后清空进展窗口，让模型在新路径上重新累积进展。 */
  private resetProgressWindow(): void {
    this.roundsWithoutProgress = 0
    this.repeatedSuccessCount = 0
    this.lastSuccessSignature = null
    this.lastSuccessToolName = null
    this.loopRecoveryIssued = null
  }

  /** 主会话每隔固定轮次让模型对照原始目标自检一次，不停止。 */
  private takeSelfCheck(toolRound: number): StopDecision | null {
    if (toolRound <= 0 || toolRound % SELF_CHECK_ROUND_INTERVAL !== 0) return null
    if (toolRound === this.lastSelfCheckRound) return null
    this.lastSelfCheckRound = toolRound
    return {
      stop: false,
      instruction:
        `[Runtime check] You have made ${toolRound} tool rounds on this task. Before continuing, ` +
        `briefly compare your completed work against the user's original request: list what is ` +
        `done and what remains. If you notice yourself repeating an approach that is not ` +
        `producing results, switch to a different one. Then continue working — do not stop.`
    }
  }

  private isNeutral(name: string, args: Record<string, unknown>): boolean {
    return this.isProgressNeutral?.(name, args) === true
  }

  private loopRecoveryInstruction(kind: NoProgressKind, toolName?: string): string {
    const repeated = kind === 'repeated_call'
    return repeated
      ? `[Runtime guard] "${toolName}" has now succeeded repeatedly with identical arguments, ` +
        `which means this path is no longer producing new information. Stop repeating it. ` +
        `Re-read what you already have and continue with a genuinely different step.`
      : `[Runtime guard] The last ${NO_PROGRESS_ROUND_LIMIT} tool rounds produced no new ` +
        `successful results. Re-read what you already have, then take a different step: ` +
        `narrow the scope, verify an assumption, or ask the user for a missing decision.`
  }

  private noProgressNotice(kind: NoProgressKind): string {
    const detail = kind === 'repeated_call'
      ? '检测到同一个工具调用被反复重复'
      : `检测到连续 ${NO_PROGRESS_ROUND_LIMIT} 轮没有新的进展`
    if (this.audience === 'subagent') {
      return `\n\n[已自动中断] ${detail}，已停止本轮以避免空转。`
    }
    return `\n\n[已自动中断] ${detail}，` +
      `任务可能尚未完成，已暂停以避免无限循环。发送「继续」可接着执行。`
  }

  private breakerNotice(toolName: string): string {
    return this.audience === 'subagent'
      ? `\n\n[已自动中断] 对「${toolName}」的相同失败调用在恢复提示后仍被重复，` +
        `已停止本轮以避免无效循环。失败原因见上方的工具错误信息。`
      : `\n\n[已自动中断] 对「${toolName}」的相同失败调用在恢复提示后仍被重复，` +
        `已停止本轮以避免无效循环。` +
        `请查看上方的工具错误信息后再调整指令。`
  }

  private maxRoundsNotice(maxToolRounds: number): string {
    return this.audience === 'subagent'
      ? `\n\n[已达到最大工具调用轮数 ${maxToolRounds}] ` +
        `任务尚未完成，以上为截断前的执行进展；` +
        `如需继续，请由调用方以更窄的范围重新派遣子任务。`
      : `\n\n[已达到最大工具调用轮数 ${maxToolRounds}] ` +
        `任务可能尚未完成，已暂停以避免无限循环。` +
        `发送「继续」可接着执行；如长任务频繁触发，可在「设置 → 通用 → 单次任务工具轮数上限」中调大该上限。`
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
