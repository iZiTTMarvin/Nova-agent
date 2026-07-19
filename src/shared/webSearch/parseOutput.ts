import type { SearchSource } from './types'

export interface ParsedWebSearchOutput {
  /** answer 段落（## Sources 之前的内容） */
  answer: string
  /** 解析出的来源列表 */
  sources: SearchSource[]
}

const SOURCES_HEADER = '## Sources'

/**
 * 解析 web_search 工具输出的纯文本。
 * 格式与 formatForLLM 对齐。
 */
export function parseWebSearchOutput(output: string): ParsedWebSearchOutput {
  const sourcesIndex = output.indexOf(SOURCES_HEADER)
  const answer =
    sourcesIndex >= 0 ? output.slice(0, sourcesIndex).trim() : output.trim()

  if (sourcesIndex < 0) {
    return { answer, sources: [] }
  }

  const sourcesBlock = output.slice(sourcesIndex + SOURCES_HEADER.length).trim()
  const sources: SearchSource[] = []

  const entryRegex = /^\[(\d+)\]\s+(.+)$/gm
  const lines = sourcesBlock.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const match = /^\[(\d+)\]\s+(.+)$/.exec(line)
    if (!match) {
      i++
      continue
    }

    const title = match[2].trim()
    let url = ''
    let snippet = ''

    if (i + 1 < lines.length && lines[i + 1].startsWith('    ')) {
      url = lines[i + 1].trim()
      i++
    }

    if (i + 1 < lines.length && lines[i + 1].startsWith('    ') && !lines[i + 1].trim().startsWith('http')) {
      const candidate = lines[i + 1].trim()
      if (!candidate.match(/^https?:\/\//)) {
        snippet = candidate
        i++
      }
    }

    if (url) {
      sources.push({ title, url, snippet: snippet || undefined })
    }

    i++
  }

  if (sources.length === 0) {
    entryRegex.lastIndex = 0
    let m: RegExpExecArray | null
    const titles: Array<{ title: string; index: number }> = []
    while ((m = entryRegex.exec(sourcesBlock)) !== null) {
      titles.push({ title: m[2].trim(), index: m.index })
    }
    for (let j = 0; j < titles.length; j++) {
      const start = titles[j].index
      const end = j + 1 < titles.length ? titles[j + 1].index : sourcesBlock.length
      const chunk = sourcesBlock.slice(start, end)
      const chunkLines = chunk.split('\n').map(l => l.trim()).filter(Boolean)
      const urlLine = chunkLines.find(l => /^https?:\/\//.test(l))
      const snippetLine = chunkLines.find(
        (l, idx) => idx > 1 && l && !/^https?:\/\//.test(l) && !/^\[\d+\]/.test(l)
      )
      if (urlLine) {
        sources.push({
          title: titles[j].title,
          url: urlLine,
          snippet: snippetLine || undefined
        })
      }
    }
  }

  return { answer, sources }
}
