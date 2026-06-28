/**
 * 将 SearchResponse 格式化为模型友好的纯文本
 */
import type { SearchResponse } from './types'

/** 单条 source 的 snippet 最大显示长度（字符） */
const SNIPPET_TRUNCATE_CHARS = 240

/**
 * 把 SearchResponse 格式化成模型友好的纯文本。
 *
 * 格式：
 * ```
 * <answer>
 *
 * ## Sources
 * [1] <title>
 *     <url>
 *     <snippet 截断到240字符>
 * ```
 */
export function formatForLLM(response: SearchResponse): string {
  const lines: string[] = []

  if (response.answer) {
    lines.push(response.answer)
    lines.push('')
  }

  lines.push('## Sources')
  response.sources.forEach((source, index) => {
    const num = index + 1
    lines.push(`[${num}] ${source.title}`)
    lines.push(`    ${source.url}`)
    if (source.snippet) {
      const truncated =
        source.snippet.length > SNIPPET_TRUNCATE_CHARS
          ? source.snippet.slice(0, SNIPPET_TRUNCATE_CHARS) + '…'
          : source.snippet
      lines.push(`    ${truncated}`)
    }
    lines.push('')
  })

  return lines.join('\n').trimEnd()
}
