const CAPABILITY_HEADING = /^#{1,6}\s+(?:\d+[.、)）]\s*)?做完你能做什么\s*[:：]?\s*$/

/** 从程序生成的一页纸读取展示条目；兼容已保存的 Markdown 计划。 */
export function parseCapabilityItems(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex(line => CAPABILITY_HEADING.test(line.trim()))
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

/** 结构化清单负责验收条目，Markdown 只负责呈现。修订时替换旧清单而非叠加。 */
export function formatBlueprintContent(markdown: string, capabilities: readonly string[]): string {
  const body: string[] = []
  let inCapabilities = false
  for (const line of markdown.split(/\r?\n/)) {
    if (CAPABILITY_HEADING.test(line.trim())) {
      inCapabilities = true
      continue
    }
    if (inCapabilities && /^#{1,6}\s/.test(line.trim())) inCapabilities = false
    if (!inCapabilities) body.push(line)
  }
  return `${body.join('\n').trimEnd()}\n\n## 做完你能做什么\n${capabilities.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
}
