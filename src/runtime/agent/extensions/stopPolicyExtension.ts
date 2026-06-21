/**
 * stopPolicyExtension — 停止策略扩展（PRD §6.2 shouldStopAfterTurn / §8 Phase 3）
 *
 * 对标现状 sendMessage L876-900：
 * - 重复失败熔断（trackRepeatedFailures）：相同签名累加、成功清零、达 REPEATED_FAILURE_LIMIT 熔断。
 * - maxToolRounds 上限提示。
 *
 * 关键语义（用户决策）：熔断计数保持"batch 之后、整批、按源顺序"形态，不拆 per-tool。
 * 原因：并行模式下 per-tool 回调按完成顺序触发，会改变"多签名同时逼近阈值时熔断提示
 * 报哪个工具名"的行为——并发边角的隐性 C1 漂移。
 *
 * 熔断计数 Map 所有权：本扩展实例态。每条用户消息开始时由 Facade 调 clear() 重置
 * （对标现状 sendMessage 开头 repeatedFailureCounts.clear()）。
 */
import type { ChatToolCall } from '../../model/types'
import type { ShouldStopArgs, StopDecision } from '../core/loopTypes'

/** 同一签名工具调用累计失败达到该次数即熔断，停止本轮循环 */
export const REPEATED_FAILURE_LIMIT = 3

/**
 * 停止策略扩展。持有熔断计数 Map（实例态）。
 */
export class StopPolicyExtension {
  private repeatedFailureCounts = new Map<string, number>()

  /** 每条用户消息开始时清空熔断计数（对标现状 repeatedFailureCounts.clear()） */
  clear(): void {
    this.repeatedFailureCounts.clear()
  }

  /**
   * shouldStopAfterTurn 回调（config.shouldStopAfterTurn）。
   * 逐字节对标现状 trackRepeatedFailures + maxRounds 提示逻辑。
   *
   * @returns StopDecision（breaker / max_rounds）或 undefined（继续）
   */
  async shouldStopAfterTurn(args: ShouldStopArgs): Promise<StopDecision | void> {
    // ── 熔断判定（整批、按源顺序；对标现状 trackRepeatedFailures L1082-1114）──
    const stuckTool = this.trackRepeatedFailures(args.outcomes)
    if (stuckTool) {
      const notice =
        `\n\n[已自动中断] 检测到对「${stuckTool}」的相同调用连续失败 ` +
        `${REPEATED_FAILURE_LIMIT} 次，已停止本轮以避免无效循环。` +
        `请查看上方的工具错误信息后再调整指令。`
      return { stop: true, reason: 'breaker', notice }
    }

    // ── maxToolRounds 上限提示（对标现状 L893-900）──
    if (args.toolRound >= args.maxToolRounds) {
      const notice =
        `\n\n[已达到最大工具调用轮数 ${args.maxToolRounds}] ` +
        `任务可能尚未完成，已暂停以避免无限循环。` +
        `发送「继续」可接着执行；如长任务频繁触发，可在「设置 → 通用 → 最大工具调用轮数」中调大该上限。`
      return { stop: true, reason: 'max_rounds', notice }
    }
  }

  /**
   * 跟踪并检测重复失败的工具调用（逐字节对标现状 trackRepeatedFailures）。
   *
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
