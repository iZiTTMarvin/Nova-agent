/**
 * bash 工具输出在 UI 层的展示截断（与 store 层 sanitizeToolOutput 互补）。
 *
 * store 已把 tool_result 控在约 8KB；此处再对 bash 展开区的 <pre> 做尾部保留截断，
 * 避免极端长行或未来放宽 store 阈值时，word-break: break-all 触发全文同步布局。
 * 策略对齐 OpenCowork ToolCallCard 的 LIVE_SHELL_OUTPUT_MAX_CHARS。
 */

/** bash 卡片内展示的最大字符数（保留尾部，错误信息多在末尾） */
export const LIVE_SHELL_OUTPUT_MAX_CHARS = 12_000

export interface BashShellDisplaySlice {
  text: string
  truncated: boolean
  /** 被省略的前缀字符数 */
  omittedChars: number
  totalChars: number
}

/**
 * 将 bash 输出裁到展示上限，保留末尾字符。
 */
export function clampBashShellOutputForDisplay(
  output: string,
  maxChars: number = LIVE_SHELL_OUTPUT_MAX_CHARS
): BashShellDisplaySlice {
  const totalChars = output.length
  if (totalChars <= maxChars) {
    return { text: output, truncated: false, omittedChars: 0, totalChars }
  }
  return {
    text: output.slice(-maxChars),
    truncated: true,
    omittedChars: totalChars - maxChars,
    totalChars
  }
}
