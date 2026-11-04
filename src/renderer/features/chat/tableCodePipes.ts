/**
 * 表格行内代码里的竖线保护。
 *
 * Astryx 的表格按每个未转义的 `|` 切列，不认行内代码边界，
 * 模型常写的 `curl | sh`、`$|x|$` 会把一格拆成多列并留下孤立反引号。
 * 解析前把表格行里代码段内的 `|`（含 `\|`）换成私用区占位符，
 * 行内代码渲染时再还原，显示与复制的仍是原字符。
 */

/** 私用区字符，正常文本不会出现 */
export const TABLE_CODE_PIPE = '\uE000'

const FENCE_LINE_RE = /^\s*(```|~~~)/

function isTableSeparator(line: string): boolean {
  if (!line.includes('|')) return false
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  return cells.length > 0 && cells.every(cell => /^\s*:?-+:?\s*$/.test(cell))
}

/** 把一行中反引号代码段内的竖线换成占位符；未闭合的反引号原样保留 */
function protectLine(line: string): string {
  if (!line.includes('`')) return line
  let out = ''
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i]
      i += 1
      continue
    }
    let ticks = 1
    while (line[i + ticks] === '`') ticks += 1
    const marker = '`'.repeat(ticks)
    const close = line.indexOf(marker, i + ticks)
    if (close === -1) {
      out += line.slice(i)
      break
    }
    const inner = line.slice(i + ticks, close).replace(/\\?\|/g, TABLE_CODE_PIPE)
    out += marker + inner + marker
    i = close + ticks
  }
  return out
}

/** 对 Markdown 文本中的表格行（表头、分隔行之后的数据行）做竖线保护；围栏代码块内不处理 */
export function protectTableCodePipes(markdown: string): string {
  if (!markdown.includes('|') || !markdown.includes('`')) return markdown
  const lines = markdown.split('\n')
  let inFence = false
  let inTable = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence
      inTable = false
      continue
    }
    if (inFence) continue
    if (inTable) {
      // 与 Astryx 一致：含竖线的非空行都算表格行
      if (line.trim() !== '' && line.includes('|')) {
        lines[index] = protectLine(line)
        continue
      }
      inTable = false
    }
    const next = lines[index + 1]
    if (line.includes('|') && next !== undefined && isTableSeparator(next)) {
      lines[index] = protectLine(line)
      index += 1
      inTable = true
    }
  }
  return lines.join('\n')
}

/** 行内代码渲染前还原占位符 */
export function restoreTableCodePipes(text: string): string {
  return text.includes(TABLE_CODE_PIPE) ? text.split(TABLE_CODE_PIPE).join('|') : text
}
