/**
 * 单轮停止策略：重复失败熔断、工具轮数上限和连续空参保护。
 *
 * 失败计数在整个 batch 完成后按调用源顺序更新。并行工具若按完成顺序计数，
 * 多个签名同时达到阈值时会产生不稳定的熔断提示。
 */
import type { ShouldStopArgs, StopDecision } from '../core/loopTypes'

/** 同一签名工具调用累计失败达到该次数即熔断，停止本轮循环 */
export const REPEATED_FAILURE_LIMIT = 3

/** 连续全空参轮次达到该次数即中断，避免 native 弱实现空转 */
export const EMPTY_ARGS_LIMIT = 2

/**
 * 停止策略扩展。持有熔断计数 Map（实例态）。
 */
export class StopPolicyExtension {
  private repeatedFailureCounts = new Map<string, number>()
  /** 连续「本轮所有 tool_calls 参数均为空」的轮次计数 */
  private emptyArgsRoundCount = 0

  /** 每条用户消息开始时清空轮次级计数。 */
  clear(): void {
    this.repeatedFailureCounts.clear()
    this.emptyArgsRoundCount = 0
  }

  /** 返回停止决定；没有命中保护条件时继续下一轮。 */
  async shouldStopAfterTurn(args: ShouldStopArgs): Promise<StopDecision | void> {
    const emptyArgsStop = this.trackEmptyArgsRounds(args)
    if (emptyArgsStop) return emptyArgsStop

    const stuckTool = this.trackRepeatedFailures(args.outcomes)
    if (stuckTool) {
      const notice =
        `\n\n[已自动中断] 检测到对「${stuckTool}」的相同调用连续失败 ` +
        `${REPEATED_FAILURE_LIMIT} 次，已停止本轮以避免无效循环。` +
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
   * 对每个非中断的工具结果计算签名（工具名 + 序列化参数）：
   * - 失败结果累加该签名的失败计数；
   * - 成功结果清零该签名计数（说明该调用已不再卡住）。
   * 当任一签名累计失败次数达到 REPEATED_FAILURE_LIMIT，返回对应工具名表示需要熔断；
   * 否则返回 null。只有「参数完全相同」的调用才会累加。
   *
   * @returns 触发熔断的工具名；未触发返回 null
   */
  private trackRepeatedFailures(
    outcomes: Array<{
      toolCall: { id: string; name: string }
      args: Record<string, unknown>
      resultText: string
      failed?: boolean
      skippedByAbort?: boolean
    }>
  ): string | null {
    for (const outcome of outcomes) {
      if (outcome.skippedByAbort) continue

      const failed = outcome.failed === true
      // 参数可能含大体量内容（如 write 的 content），签名做长度上限保护，
      // 仅用于「是否同一调用」的判定，过长时截断不影响判等的稳定性。
      let argsKey: string
      try {
        argsKey = JSON.stringify(outcome.args)
      } catch {
        argsKey = String(outcome.args)
      }
      const signature = `${outcome.toolCall.name}:${argsKey.slice(0, 4096)}`

      if (failed) {
        const next = (this.repeatedFailureCounts.get(signature) ?? 0) + 1
        this.repeatedFailureCounts.set(signature, next)
        if (next >= REPEATED_FAILURE_LIMIT) {
          return outcome.toolCall.name
        }
      } else {
        this.repeatedFailureCounts.delete(signature)
      }
    }
    return null
  }
}

/** 判断参数对象是否为空（{} 或无有效字段） */
function isEmptyArgsRecord(args: Record<string, unknown>): boolean {
  return Object.keys(args).length === 0
}
