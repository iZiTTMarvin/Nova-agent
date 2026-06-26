/**
 * permissionExtension — 权限扩展工厂（PRD §6.2 beforeToolCall / §8 Phase 3）
 *
 * 对标现状 checkPermission（AgentLoop L1499-1551）：plan 模式 / PermissionManager /
 * ask 等待 / PermissionAbortedError。
 *
 * 薄包装策略（用户决策）：executeToolBatch 零改动。本扩展产出的 checkPermission 回调
 * 仍通过 executeToolBatch 的 options.checkPermission 注入，签名与现状完全一致。
 * 完整保留 PermissionAbortedError → {aborted:true} → 跳过 tool_result 这条路径。
 */
import type { AgentLoop } from '../AgentLoop'

/**
 * 创建 checkPermission 回调（executeToolBatch options.checkPermission）。
 * 直接代理到 AgentLoop.checkPermission（私有方法，通过 bind 暴露）。
 *
 * AgentLoop 在装配 executeBatch 时把此回调作为 option 传入：
 *   (toolName, args, messageId, toolCallId?) => Promise<{allowed, reason, aborted?}>
 *
 * 末尾新增可选 toolCallId：用于权限内联化——把待授权请求对应到消息流中
 * 具体的工具卡片。bash 走批量路径自带 toolCallId，此处覆盖非 bash 的单工具 ask 场景。
 */
export function createPermissionExtension(loop: AgentLoop): (
  toolName: string,
  args: Record<string, unknown>,
  messageId: string,
  toolCallId?: string
) => Promise<{ allowed: boolean; reason: string; aborted?: boolean }> {
  // AgentLoop.checkPermission 是 private，通过 (loop as any) 访问（与现状内联调用一致）。
  // 保持薄包装：不改 checkPermission 内部的 plan 模式 / PermissionManager / ask 等待逻辑。
  return (toolName, args, messageId, toolCallId) =>
    (loop as unknown as {
      checkPermission: (
        toolName: string,
        args: Record<string, unknown>,
        messageId: string,
        toolCallId?: string
      ) => Promise<{ allowed: boolean; reason: string; aborted?: boolean }>
    }).checkPermission(toolName, args, messageId, toolCallId)
}
