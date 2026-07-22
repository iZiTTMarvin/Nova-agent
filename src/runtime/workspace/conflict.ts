/**
 * 工作区写冲突的结构化结果。
 *
 * 当写者租约被其它 run 持有（等待超时），或检测到「文件在 read 之后被外部修改」时，
 * 不再以硬错误中断 turn，而是返回结构化的冲突结果，让 agent 重新读取并重新规划。
 * 这对 agent 更友好，同时不破坏 safetyGate 的安全语义（仍然禁止盲目覆盖）。
 */
import type { ToolResult } from '../tools/types'
import { writerLeaseRegistry, type AcquireResult } from './WriterLease'

/** 冲突结果 output 前缀；工具结果 / 日志据此识别冲突种类。 */
export const WORKSPACE_CONFLICT_PREFIX = 'WORKSPACE_CONFLICT'

/** 判断一个 ToolResult 是否为工作区写冲突。 */
export function isWorkspaceConflictResult(result: ToolResult): boolean {
  return !result.success && result.output.startsWith(WORKSPACE_CONFLICT_PREFIX)
}

/** 构造「另一个会话正在写入工作区」的冲突结果（写者租约未拿到时使用）。 */
export function workspaceConflictResult(reason: 'lease_timeout' | 'externally_modified', hint?: string): ToolResult {
  const guidance =
    reason === 'lease_timeout'
      ? '另一个会话正在写入工作区。你可以：1) 等它完成后重试；2) 先做只读分析。'
      : '该文件在你读取后被外部修改。请重新用 read 工具读取最新内容后再编辑。'
  return {
    success: false,
    output: `${WORKSPACE_CONFLICT_PREFIX}: ${guidance}${hint ? `\n${hint}` : ''}`,
    error: guidance
  }
}

/**
 * 尝试为本 run 在工作区获取写者租约；拿不到时返回冲突 ToolResult，拿到返回 null。
 *
 * 调用方（edit / write / 破坏性 bash）在执行实际写操作前调用：
 * 返回 null 表示可以继续写；返回 ToolResult 表示应直接把该结果交回 agent，跳过写操作。
 *
 * 缺少 runId / workspaceRoot（子代理 / 旧路径未注入）时直接放行，保持向后兼容。
 */
export async function acquireWriterLeaseOrConflict(params: {
  runId?: string
  workspaceRoot?: string
  timeoutMs?: number
}): Promise<ToolResult | null> {
  const { runId, workspaceRoot, timeoutMs } = params
  if (!runId || !workspaceRoot) return null
  const result: AcquireResult = await writerLeaseRegistry.acquire(
    workspaceRoot,
    runId,
    timeoutMs
  )
  if (result.ok) return null
  return workspaceConflictResult('lease_timeout')
}
