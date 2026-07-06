/**
 * 按行 / Markdown 标题边界截断，不截断行内（句中）。
 * 超限时优先在最后一个完整标题块前截断，否则在最后一整行处截断。
 */
export function truncateAtLineOrHeaderBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text

  const lines = text.split('\n')
  let acc = ''
  /** 上一个标题行之前的累积正文（可作为截断点） */
  let lastHeaderBoundary = ''

  for (const line of lines) {
    const isHeader = /^#{1,6}\s/.test(line)
    const next = acc.length === 0 ? line : `${acc}\n${line}`

    if (next.length > maxChars) {
      if (lastHeaderBoundary.length > 0) {
        return lastHeaderBoundary.trimEnd()
      }
      return acc.trimEnd()
    }

    if (isHeader && acc.length > 0) {
      lastHeaderBoundary = acc
    }
    acc = next
  }

  return acc.trimEnd()
}
