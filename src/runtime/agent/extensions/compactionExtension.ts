/**
 * compactionExtension — 主动阈值压缩扩展（PRD §6.2 transformContext / §8 Phase 3）
 *
 * 对标现状 sendMessage L722-731：!compressingForOverflow 守卫下，
 * getCompactionThreshold + shouldCompact + runCompaction。
 *
 * 本扩展是 Facade 端实现（runCompaction 复用 AgentLoop 既有方法），
 * 由 runAgentLoop 通过 runCompactionIfThreshold 回调注入，而非走 config.transformContext。
 * 原因：runCompaction 需要 AgentLoop 的多个 Facade 态（context/idleTimer/modelPool），
 * 放 Facade 端更自然；runAgentLoop 只负责"在 stream 前、守卫下调用一次"。
 */
import { getCompactionThreshold, shouldCompact } from '../compaction'
import { estimateContextTokens } from '../tokenEstimator'
import type { AgentContext } from '../core/AgentContext'

export interface CompactionExtensionDeps {
  context: AgentContext
  /** 模型上下文窗口（config.contextWindow，默认 200000） */
  contextWindow: number
  /** 读取溢出压缩守卫态（compressingForOverflow） */
  isCompressingForOverflow: () => boolean
  /** 执行压缩（AgentLoop.runCompaction） */
  runCompaction: () => Promise<void>
}

/**
 * 创建主动阈值压缩回调（runAgentLoop.runCompactionIfThreshold）。
 * 逐字节对标现状：shouldCompact 的四个参数（context, threshold, tokensToCompare, userTurnsSinceCompaction）。
 */
export function createCompactionExtension(deps: CompactionExtensionDeps): () => Promise<void> {
  const { context, contextWindow, isCompressingForOverflow, runCompaction } = deps
  return async () => {
    // 守卫：正在执行溢出压缩时跳过（由 runAgentLoop 调用前已守卫，这里保留防御性双重检查）
    if (isCompressingForOverflow()) return
    const compactionThreshold = getCompactionThreshold(contextWindow)
    // 2.4 守卫：使用上轮估算/API实际报告的 token 数和当前实时估算中的较大值，防范反复触发
    const currentTokens = estimateContextTokens(context.messages)
    const tokensToCompare = Math.max(currentTokens, context.lastEstimatedTokens)
    if (shouldCompact(context.messages, compactionThreshold, tokensToCompare, context.userTurnsSinceCompaction)) {
      await runCompaction()
    }
  }
}
