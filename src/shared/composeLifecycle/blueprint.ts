/** 保存和展示共用的一页纸能力列表契约。 */
export function parseCapabilityItems(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex(line => /^#{1,6}\s+(?:\d+[.、)）]\s*)?做完你能做什么\s*[:：]?\s*$/.test(line.trim()))
  if (start < 0) return []
  const items: string[] = []
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim()
    if (/^#{1,6}\s/.test(trimmed)) break
    const match = trimmed.match(/^(?:\d+[.、)）]|[-*+])\s+(?:\[[ xX]\]\s*)?(.+)$/)
    if (match) items.push(match[1].trim())
  }
  return [...new Set(items)]
}
