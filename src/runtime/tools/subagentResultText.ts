/**
 * 子代理派遣类工具（task / task_followup）共用的结果文案与失败形态。
 * 两个工具的输出保持同构，文案漂移会让父模型无法统一判读，故单一真源；
 * batch_task 为 JSON 汇总输出，不经过本模块。
 */
import type {
  SubagentExecutionResult,
  SubagentExecutionStatus
} from '../../shared/subagents'
import type { TurnTruncationReason } from '../../shared/run/types'
import type { ToolResult } from './types'

export function failure(error: string): ToolResult {
  return { success: false, output: '', error }
}

/** 把一次子代理执行结果映射为父模型可见的同构工具输出；header 由调用方区分派遣/续跑。 */
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

/** 截断原因的可读说明（仅文案；判定不依赖文案） */
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
