/**
 * mathSyntax — 数学语法转译（$/$$ → 代码通路）
 *
 * 背景（Astryx 契约，见 astryxMarkdownKernelSpike 测试）：段落文本节点会吃掉
 * 反斜杠转义，LaTeX 源码经 prose/inlinePlugins 通路会失真；行内代码与围栏代码
 * 原样保留。因此公式渲染采用转译路线：
 * - 行首 $$...$$ 块 → ```math 围栏（components.code 路由到 KaTeX）
 * - 行内 $...$ → `$...$` 行内代码（components.inlineCode 路由到 KaTeX）
 *
 * 转译只在真实代码上下文之外进行：围栏与行内代码中的 $ 一律不动。
 * 只转译完整闭合的公式对；流式未闭合的保持原文，随封口渐进生效。
 */

const FENCE_LINE_RE = /^(```|~~~)([^\n`]*)?$/
/** 行首块级公式开符：整行仅有 $$ */
const DISPLAY_OPEN_RE = /^[ \t]{0,3}\$\$[ \t]*$/
/** 行首 $$ 起头（可能的开符或闭符） */
const DISPLAY_LINE_RE = /^[ \t]{0,3}\$\$/
/** 单行自闭合：$$ x $$ */
const DISPLAY_SINGLE_RE = /^[ \t]{0,3}\$\$([^$]+)\$\$[ \t]*$/
/** 行内公式：$...$（内容无 $、无换行） */
const INLINE_MATH_RE = /\$([^$\n]+)\$/g

export interface TransformMathResult {
  text: string
  /** 本次转译是否产生了 math 围栏（诊断用） */
  hasMath: boolean
}

/**
 * 把输入中的数学语法转译为代码通路标记。
 * 输入通常是：一个已封口的 sealed 段、active tail、或终态全文。
 * 转译对追加式增长是前缀稳定的：已闭合的公式对转换结果不再变化。
 */
export function transformMathSyntax(raw: string): TransformMathResult {
  if (!raw || !raw.includes('$')) return { text: raw, hasMath: false }

  const out: string[] = []
  let fenceMarker: string | null = null
  let hasMath = false
  const lines = raw.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    const fenceMatch = FENCE_LINE_RE.exec(line.trimEnd())
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      if (fenceMarker === null) fenceMarker = marker
      else if (marker === fenceMarker) fenceMarker = null
      out.push(line)
      i += 1
      continue
    }
    if (fenceMarker !== null) {
      out.push(line)
      i += 1
      continue
    }

    const single = DISPLAY_SINGLE_RE.exec(line)
    if (single && single[1]!.trim().length > 0) {
      out.push('```math', single[1]!.trim(), '```')
      hasMath = true
      i += 1
      continue
    }

    if (DISPLAY_OPEN_RE.test(line)) {
      // 收集到闭合行（行首 $$ 起头）；未闭合则原文保留（流式渐进）
      let j = i + 1
      let closed = false
      while (j < lines.length) {
        const candidate = lines[j]!
        if (FENCE_LINE_RE.exec(candidate.trimEnd())) break
        if (DISPLAY_LINE_RE.test(candidate)) {
          closed = true
          break
        }
        j += 1
      }
      if (closed) {
        const inner = lines.slice(i + 1, j).join('\n').trim()
        const after = lines[j]!.trim().slice(2).trim()
        out.push('```math', ...(inner ? [inner] : []), '```')
        if (after) out.push(after)
        hasMath = true
        i = j + 1
        continue
      }
    }

    out.push(transformInlineMath(line))
    i += 1
  }

  return { text: out.join('\n'), hasMath }
}

/**
 * 行内 $...$ → `$...$` 行内代码。
 * 边界规则防货币误判：内容首尾非空白、闭符后不是数字。
 * 行内代码片段（成对反引号）中的 $ 不转译。
 */
export function transformInlineMath(line: string): string {
  if (!line.includes('$')) return line
  if (!line.includes('`')) return replaceInlineMathPairs(line)

  const codeSpans: Array<[number, number]> = []
  let idx = 0
  while (idx < line.length) {
    if (line[idx] === '`') {
      const close = line.indexOf('`', idx + 1)
      if (close > idx) {
        codeSpans.push([idx, close + 1])
        idx = close + 1
        continue
      }
    }
    idx += 1
  }

  let result = ''
  let cursor = 0
  for (const [start, end] of codeSpans) {
    if (start > cursor) result += replaceInlineMathPairs(line.slice(cursor, start))
    result += line.slice(start, end)
    cursor = end
  }
  if (cursor < line.length) result += replaceInlineMathPairs(line.slice(cursor))
  return result
}

function replaceInlineMathPairs(text: string): string {
  INLINE_MATH_RE.lastIndex = 0
  return text.replace(INLINE_MATH_RE, (match, inner: string, offset: number, full: string) => {
    const first = inner[0]
    const last = inner[inner.length - 1]
    if (!first || !last) return match
    if (/\s/.test(first) || /\s/.test(last)) return match
    const nextChar = full[offset + match.length]
    if (nextChar !== undefined && /[0-9]/.test(nextChar)) return match
    return '`$' + inner + '$`'
  })
}

/**
 * 找出 [from, content.length) 内首个「未闭合的行首 $$ 块」起点；无则 -1。
 * 渲染层用它阻止封口越过未完成的公式块（与 openFence 同语义）。
 * 只扫描 from 之后的后缀，保持流式逐帧成本 O(tail)。
 */
export function findOpenDisplayMathStart(content: string, from: number): number {
  if (!content) return -1
  const searchFrom = Math.max(0, from)
  if (searchFrom >= content.length) return -1

  let fenceMarker: string | null = null
  let openStart = -1
  let offset = 0
  const lines = content.slice(searchFrom).split('\n')

  for (const line of lines) {
    const lineStart = offset
    offset += line.length + 1

    const fenceMatch = FENCE_LINE_RE.exec(line.trimEnd())
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      if (fenceMarker === null) fenceMarker = marker
      else if (marker === fenceMarker) fenceMarker = null
      continue
    }
    if (fenceMarker !== null) continue
    if (!DISPLAY_LINE_RE.test(line)) continue

    if (openStart >= 0) {
      // 处于未闭合块内：行首 $$ 即闭符
      openStart = -1
      continue
    }
    if (DISPLAY_SINGLE_RE.test(line)) continue
    if (DISPLAY_OPEN_RE.test(line)) openStart = searchFrom + lineStart
    // 行首 $$ 带尾随内容：作为某个块的闭符处理，不是 opener
  }
  return openStart
}

/** 行内代码文本是否为数学标记（`$...$` 形态，含定界符本身） */
export function unwrapInlineMathCode(children: string): string | null {
  if (children.length < 3) return null
  if (children[0] !== '$' || children[children.length - 1] !== '$') return null
  const inner = children.slice(1, -1)
  return inner.length > 0 ? inner : null
}
