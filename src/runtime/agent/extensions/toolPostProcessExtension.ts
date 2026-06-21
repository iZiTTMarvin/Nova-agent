/**
 * toolPostProcessExtension — 工具结果后处理扩展工厂（PRD §6.2 afterToolCall / §8 Phase 3）
 *
 * 对标现状 applyTruncation（AgentLoop L1034-1048）：三明治模式截断。
 *
 * 薄包装策略（用户决策）：executeToolBatch 零改动。本扩展产出的 applyTruncation 回调
 * 仍通过 executeToolBatch 的 options.applyTruncation 注入，签名与现状完全一致。
 */
import type { AgentLoop } from '../AgentLoop'

/**
 * 创建 applyTruncation 回调（executeToolBatch options.applyTruncation）。
 * 直接代理到 AgentLoop.applyTruncation（私有方法）。
 */
export function createToolPostProcessExtension(loop: AgentLoop): (output: string, maxSize: number) => string {
  return (output, maxSize) =>
    (loop as unknown as {
      applyTruncation: (output: string, maxSize: number) => string
    }).applyTruncation(output, maxSize)
}
