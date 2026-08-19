/**
 * run_code 失败语义：把沙箱失败分类翻译成模型可自我修正的文案。
 * 详细堆栈与内部状态不进入模型上下文，只留在诊断日志。
 */
import type { RunCodeFailureKind } from './types'

/** 模型可见的失败前缀；message 追加在冒号后 */
const FAILURE_LABELS: Readonly<Record<RunCodeFailureKind, string>> = {
  parse_error: '代码存在语法错误',
  execution_error: '代码执行出错',
  unknown_tool: '使用了不可用的工具',
  limit_exceeded: '超出执行资源上限',
  tool_failure: '工具调用失败',
  aborted: '执行已取消'
}

export function formatRunCodeFailure(kind: RunCodeFailureKind, message: string): string {
  const label = FAILURE_LABELS[kind]
  const detail = message.trim().length > 0 ? `：${message.trim()}` : ''
  return `${label}${detail}`
}
