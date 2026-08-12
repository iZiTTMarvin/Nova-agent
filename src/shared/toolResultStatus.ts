/**
 * 工具结果失败判定的唯一口径。
 * tool 消息没有结构化失败标记，失败态由回写文本前缀表达（执行失败 / 权限拒绝）；
 * 新增判定必须 import 这里，不得再手写前缀比较。
 */
export function isToolFailureText(text: string): boolean {
  return text.startsWith('工具执行失败') || text.startsWith('权限拒绝:')
}
