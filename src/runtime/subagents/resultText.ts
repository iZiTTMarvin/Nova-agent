/**
 * Shared subagent result text builder.
 * Lives in runtime/subagents so it can be imported by tools without creating cycles.
 */
import type {
  SubagentExecutionResult,
  SubagentExecutionStatus
} from '../../shared/subagents'
import type { TurnTruncationReason } from '../../shared/run/types'
import type { ToolResult } from '../tools/types'

export function failure(error: string): ToolResult {
  return { success: false, output: '', error }
}

export function buildSubagentToolResult(
  header: string,
  result: SubagentExecutionResult
): ToolResult {
  const output = `${header}\n${result.summary}`
  if (result.status === 'completed') {
    return { success: true, output }
  }
  return {
    success: false,
    output,
    error:
      result.failure?.message ??
      (result.status === 'incomplete'
        ? `子代理未完成任务${describeIncompleteReason(result.incompleteReason)}`
        : `子代理执行${statusLabel(result.status)}`)
  }
}

export function statusLabel(status: SubagentExecutionStatus): string {
  switch (status) {
    case 'accepted':
      return '已后台接纳'
    case 'completed':
      return '成功'
    case 'incomplete':
      return '未完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    case 'interrupted':
      return '已中断'
  }
}

export function describeIncompleteReason(reason: TurnTruncationReason | undefined): string {
  switch (reason) {
    case 'max_rounds':
      return '（已达工具轮数上限）'
    case 'breaker':
      return '（重复失败已熔断）'
    case 'empty_args':
      return '（连续空参已中断）'
    case 'deadline':
      return '（达到宿主截止时间）'
    default:
      return ''
  }
}
