/**
 * MarkdownRenderer — 模型文本输出的 Markdown 渲染器（Astryx 内核）
 *
 * 职责分层：
 * 1. 流式算法是 Nova 两阶段增量（sealed + tail，splitIncrementalMarkdown）：
 *    已封口 prefix 冻结只渲染一次，活动 tail 每帧低成本重解析。打字机节奏、
 *    暂停、后台降频由 StreamingTextBlock + render pool 拥有，本组件不引入
 *    第二份放出状态。
 * 2. 块级渐进：sealed 块与终态用 complete 组件集（代码高亮、mermaid 图表、
 *    KaTeX 公式立即生效）；active tail 用 streaming 组件集（无高亮、图表占位）。
 *    公式在 tail 也渲染——KaTeX 便宜且有缓存，未闭合的数学定界符保持原文。
 * 3. 代码块分层渲染：
 *    - 无语言/纯文本围栏（plaintext/text/txt 等）隐藏冗余顶栏，改用右上角悬浮复制按钮，
 *      且跳过语法分词，避免把普通文本中的数字、括号、斜杠误染色。
 *    - 含 Unicode 制表符/框线图的代码块启用等宽网格校准（汉字锁定 2ch、框线与箭头锁定 1ch、
 *      纵向框线脊柱自动对齐并收紧行高），消除中西文混排导致的框线断裂与错位。
 * 4. 数学语法走转译路线（mathSyntax）：Astryx 段落文本吃反斜杠，LaTeX 源码
 *    必须转成 ```math 围栏 / `$...$` 行内代码才能保真到达渲染层。
 * 5. 链接保留 isSafeMarkdownHref 安全语义（unsafe → 纯文本）；
 *    autolink="gfm" 对齐原 remark-gfm 的裸 URL 自动链接行为。
 */
import React, { useCallback, useMemo, useRef } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Markdown } from '@astryxdesign/core/Markdown'
import type { MarkdownComponents } from '@astryxdesign/core/Markdown'
import { CopyIcon, CheckIcon } from '../../components/Icons'
import { useCopyFeedback } from '../../hooks/useCopyFeedback'
import { highlightLineCached } from '../../lib/highlightCache'
import { highlightLine, detectLanguage } from '../diff/syntaxHighlight'
import { MarkdownLink } from './MarkdownLink'
import { isSafeMarkdownHref } from './safeMarkdownLink'
import { advanceIncrementalMarkdownBoundary } from './incrementalMarkdown'
import { findOpenDisplayMathStart, transformMathSyntax } from './mathSyntax'
import { protectTableCodePipes, restoreTableCodePipes } from './tableCodePipes'
import { MathFence, MathInlineCode, MATH_FENCE_LANGUAGES } from './MathBlock'
import { MermaidDiagram } from './MermaidDiagram'
import { useInlineUiScope } from '../inline-ui/InlineUiScope'
import { LEARNING_SUGGESTIONS_FENCE } from '../../../shared/learning/suggestions'
import './MarkdownRenderer.css'

const PLAIN_FENCE_LANGUAGES = new Set([
  '',
  'plain',
  'plaintext',
  'text',
  'txt',
  'ascii',
  'tree',
  'log',
  'output',
  'raw'
])

/** 包含 Unicode 制表符（U+2500..U+257F）时启用框线图等宽网格模式 */
const BOX_DRAWING_PATTERN = /[\u2500-\u257f]/

/** CJK 表意文字与全角标点（终端/等宽网格中占 2ch） */
const CJK_CHAR_RE = /[\u2e80-\u2eff\u2f00-\u2fdf\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff01-\uff60\uffe0-\uffe6]/

/** 框线图内需要锁宽度的三类片段：CJK 全角串（2ch/字）、制表符串（1ch/字）、单列箭头与几何符号（1ch） */
const DIAGRAM_SEGMENT_RE = /([\u2e80-\u2eff\u2f00-\u2fdf\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff01-\uff60\uffe0-\uffe6]+|[\u2500-\u257f]+|[\u2190-\u21ff\u25a0-\u25ff])/g

const CONNECTS_DOWN = new Set([
  '│', '┃', '║', '┌', '┍', '┎', '┏', '┐', '┑', '┒', '┓',
  '├', '┝', '┞', '┟', '┠', '┡', '┢', '┣', '┤', '┥', '┦', '┧', '┨', '┩', '┪', '┫',
  '┬', '┭', '┮', '┯', '┰', '┱', '┲', '┳', '┼', '┽', '┾', '┿', '╀', '╁', '╂', '╃', '╄', '╅', '╆', '╇', '╈', '╉', '╊', '╋'
])

const CONNECTS_UP = new Set([
  '│', '┃', '║', '└', '┕', '┖', '┗', '┘', '┙', '┚', '┛',
  '├', '┝', '┞', '┟', '┠', '┡', '┢', '┣', '┤', '┥', '┦', '┧', '┨', '┩', '┪', '┫',
  '┴', '┵', '┶', '┷', '┸', '┹', '┺', '┻', '┼', '┽', '┾', '┿', '╀', '╁', '╂', '╃', '╄', '╅', '╆', '╇', '╈', '╉', '╊', '╋'
])

const HORIZONTAL_BOX_CHARS = new Set(['─', '━', '═'])

export function isPlainCodeLanguage(language: string | undefined): boolean {
  const normalized = (language ?? '').trim().toLowerCase()
  return PLAIN_FENCE_LANGUAGES.has(normalized)
}

interface PadAdjustment {
  start: number
  end: number
  widthCh: number
}

interface SpineCandidate {
  lineIdx: number
  charEndIdx: number
  col: number
  connectsUp: boolean
  connectsDown: boolean
  spaceStart: number
  spaceEnd: number
  spaceCols: number
  postSpaceStart: number
  postSpaceEnd: number
  postSpaceCols: number
  hasLeftText: boolean
}

/**
 * 扫描多行框线图中的纵向连接符（┌/┐/┬ → │/├/┤/┼ → └/┘/┴），
 * 当模型在中英混排时因列宽漏算导致同一条竖线出现 ±1..6 列抖动时，
 * 通过调整连接符前方空白段的 CSS 宽度（不改动 textContent 字符）将竖线拉直。
 */
function computeDiagramSpineAdjustments(lines: string[]): Map<number, PadAdjustment[]> {
  const result = new Map<number, PadAdjustment[]>()
  if (lines.length < 2 || lines.length > 100) return result

  const lineCandidates: SpineCandidate[][] = lines.map((line, lineIdx) => {
    const candidates: SpineCandidate[] = []
    let col = 0
    let idx = 0

    while (idx < line.length) {
      const codePoint = line.codePointAt(idx)!
      const ch = String.fromCodePoint(codePoint)
      const charLen = ch.length
      const width = CJK_CHAR_RE.test(ch) ? 2 : 1

      if (CONNECTS_DOWN.has(ch) || CONNECTS_UP.has(ch)) {
        let barStart = idx
        while (barStart > 0 && HORIZONTAL_BOX_CHARS.has(line[barStart - 1])) {
          barStart--
        }
        let spaceStart = barStart
        while (spaceStart > 0 && line[spaceStart - 1] === ' ') {
          spaceStart--
        }

        if (barStart > spaceStart) {
          const leftSlice = line.slice(0, spaceStart)
          const hasLeftText = /[^\s\u2500-\u257f]/.test(leftSlice)

          // 记录连接符（及其右侧箭头如 ├──►）之后的连续空格，供右移时补偿缩减
          let postBarEnd = idx + charLen
          while (
            postBarEnd < line.length &&
            (HORIZONTAL_BOX_CHARS.has(line[postBarEnd]) || /[\u2190-\u21ff\u25a0-\u25ff]/.test(line[postBarEnd]))
          ) {
            postBarEnd++
          }
          let postSpaceEnd = postBarEnd
          while (postSpaceEnd < line.length && line[postSpaceEnd] === ' ') {
            postSpaceEnd++
          }

          candidates.push({
            lineIdx,
            charEndIdx: idx + charLen,
            col,
            connectsUp: CONNECTS_UP.has(ch),
            connectsDown: CONNECTS_DOWN.has(ch),
            spaceStart,
            spaceEnd: barStart,
            spaceCols: barStart - spaceStart,
            postSpaceStart: postBarEnd,
            postSpaceEnd,
            postSpaceCols: postSpaceEnd - postBarEnd,
            hasLeftText
          })
        }
      }

      col += width
      idx += charLen
    }

    return candidates
  })

  const nextLink = new Map<SpineCandidate, SpineCandidate>()
  const prevLink = new Map<SpineCandidate, SpineCandidate>()

  for (let i = 0; i < lineCandidates.length - 1; i++) {
    const downs = lineCandidates[i].filter(c => c.connectsDown)
    const ups = lineCandidates[i + 1].filter(c => c.connectsUp)

    for (const d of downs) {
      let bestU: SpineCandidate | null = null
      let bestDist = 7
      for (const u of ups) {
        const dist = Math.abs(d.col - u.col)
        if (dist < bestDist) {
          bestDist = dist
          bestU = u
        }
      }
      if (!bestU) continue

      // 互为最近邻验证，防止目录树缩进阶梯误连
      let reverseBestD: SpineCandidate | null = null
      let reverseDist = 7
      for (const d2 of downs) {
        const dist = Math.abs(d2.col - bestU.col)
        if (dist < reverseDist) {
          reverseDist = dist
          reverseBestD = d2
        }
      }

      if (reverseBestD === d) {
        nextLink.set(d, bestU)
        prevLink.set(bestU, d)
      }
    }
  }

  const chains: SpineCandidate[][] = []
  for (const row of lineCandidates) {
    for (const cand of row) {
      if (prevLink.has(cand) || !nextLink.has(cand)) continue
      const chain: SpineCandidate[] = [cand]
      let curr: SpineCandidate | undefined = nextLink.get(cand)
      while (curr) {
        chain.push(curr)
        curr = nextLink.get(curr)
      }
      if (chain.length >= 2) {
        chains.push(chain)
      }
    }
  }

  chains.sort(
    (a, b) => Math.min(...a.map(c => c.col)) - Math.min(...b.map(c => c.col))
  )

  const lineShift = new Array<number>(lines.length).fill(0)

  for (const chain of chains) {
    if (!chain.some(c => c.hasLeftText)) continue
    const effectiveCols = chain.map(c => c.col + lineShift[c.lineIdx])
    const minCol = Math.min(...effectiveCols)
    const maxCol = Math.max(...effectiveCols)
    if (maxCol <= minCol || maxCol - minCol > 6) continue

    for (const cand of chain) {
      const currentCol = cand.col + lineShift[cand.lineIdx]
      const delta = maxCol - currentCol
      if (delta <= 0) continue

      const list = result.get(cand.lineIdx) ?? []
      list.push({
        start: cand.spaceStart,
        end: cand.spaceEnd,
        widthCh: cand.spaceCols + delta
      })

      // 若连接符右侧还有跟进文本且空格充裕，缩减右侧空格以保持右侧文字列位置稳定
      if (cand.postSpaceCols >= delta + 2 && cand.postSpaceEnd < lines[cand.lineIdx].length) {
        list.push({
          start: cand.postSpaceStart,
          end: cand.postSpaceEnd,
          widthCh: cand.postSpaceCols - delta
        })
      } else {
        lineShift[cand.lineIdx] += delta
      }

      result.set(cand.lineIdx, list)
    }
  }

  return result
}

function renderDiagramSlice(text: string, keyPrefix: string): React.ReactNode {
  if (!text) return null
  const nodes: React.ReactNode[] = []
  let lastIndex = 0
  let partIdx = 0

  for (const match of text.matchAll(DIAGRAM_SEGMENT_RE)) {
    const seg = match[0]
    const index = match.index ?? 0
    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index))
    }

    const firstChar = seg[0]
    const codePoint = seg.codePointAt(0) ?? 0
    const charCount = Array.from(seg).length

    if (CJK_CHAR_RE.test(firstChar)) {
      nodes.push(
        <span
          key={`${keyPrefix}-cjk-${partIdx++}`}
          className="md-diagram-cjk"
          style={{ width: `${charCount * 2}ch` }}
        >
          {seg}
        </span>
      )
    } else if (codePoint >= 0x2500 && codePoint <= 0x257f) {
      nodes.push(
        <span
          key={`${keyPrefix}-box-${partIdx++}`}
          className="md-diagram-box"
          style={{ width: `${charCount}ch` }}
        >
          {seg}
        </span>
      )
    } else {
      nodes.push(
        <span key={`${keyPrefix}-sym-${partIdx++}`} className="md-diagram-sym">
          {seg}
        </span>
      )
    }

    lastIndex = index + seg.length
  }

  if (lastIndex === 0) return text
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  return nodes
}

function renderDiagramLine(
  line: string,
  lineIdx: number,
  pads: PadAdjustment[] | undefined
): React.ReactNode {
  if (!pads || pads.length === 0) {
    return renderDiagramSlice(line, `L${lineIdx}`)
  }

  const sorted = [...pads].sort((a, b) => a.start - b.start)
  const parts: React.ReactNode[] = []
  let cursor = 0

  for (let i = 0; i < sorted.length; i++) {
    const pad = sorted[i]
    if (pad.start > cursor) {
      parts.push(renderDiagramSlice(line.slice(cursor, pad.start), `L${lineIdx}-s${i}`))
    }
    parts.push(
      <span
        key={`L${lineIdx}-pad-${i}`}
        className="md-diagram-pad"
        style={{ width: `${pad.widthCh}ch` }}
      >
        {line.slice(pad.start, pad.end)}
      </span>
    )
    cursor = pad.end
  }

  if (cursor < line.length) {
    parts.push(renderDiagramSlice(line.slice(cursor), `L${lineIdx}-tail`))
  }
  return parts
}

interface CodeBlockProps {
  language: string
  code: string
  isStreaming?: boolean
}

const CodeBlock: React.FC<CodeBlockProps> = ({ language, code, isStreaming = false }) => {
  const { copied, isDecaying, copy } = useCopyFeedback()

  const handleCopy = useCallback(() => {
    copy(code)
  }, [code, copy])

  const normalizedLang = (language ?? '').trim().toLowerCase()
  const isPlain = isPlainCodeLanguage(normalizedLang)
  const canHighlight = !isPlain && detectLanguage(normalizedLang) !== 'plain'
  const isDiagram = useMemo(() => BOX_DRAWING_PATTERN.test(code), [code])
  const lines = useMemo(() => code.split('\n'), [code])
  const spinePads = useMemo(
    () => (isDiagram && !isStreaming ? computeDiagramSpineAdjustments(lines) : undefined),
    [isDiagram, isStreaming, lines]
  )

  const copyButton = (
    <Button
      label={copied ? '已复制' : '复制'}
      variant="ghost"
      size="sm"
      icon={
        copied ? (
          <span className={isDecaying ? 'copy-feedback-icon copy-feedback-icon--decaying' : 'copy-feedback-icon'}>
            <CheckIcon size={12} />
          </span>
        ) : (
          <CopyIcon size={12} />
        )
      }
      className={isPlain ? 'md-code-block__copy md-code-block__copy--floating' : 'md-code-block__copy'}
      onClick={handleCopy}
      tooltip="复制代码"
    />
  )

  return (
    <div className={isPlain ? 'md-code-block md-code-block--plain' : 'md-code-block'}>
      {isPlain ? (
        copyButton
      ) : (
        <div className="md-code-block__header">
          <span className="md-code-block__lang">{normalizedLang}</span>
          {copyButton}
        </div>
      )}
      <pre className={isDiagram ? 'md-code-block__pre md-code-block__pre--diagram' : 'md-code-block__pre'}>
        <code>
          {lines.map((line, idx) => (
            <React.Fragment key={idx}>
              {idx > 0 && '\n'}
              {isStreaming || !canHighlight
                ? isDiagram
                  ? renderDiagramLine(line, idx, spinePads?.get(idx))
                  : line
                : highlightLineCached(line, normalizedLang, highlightLine).map((token, tIdx) => (
                    <span key={tIdx} className={`diff-token diff-token--${token.type}`}>
                      {isDiagram ? renderDiagramSlice(token.text, `L${idx}-T${tIdx}`) : token.text}
                    </span>
                  ))}
            </React.Fragment>
          ))}
        </code>
      </pre>
    </div>
  )
}

interface MarkdownRendererProps {
  content: string
  /**
   * 是否处于流式生成中。流式期间：
   * - 走两阶段增量（sealed + tail），避免全文重解析
   * - sealed 块已按终态渲染（高亮/图表/公式），tail 无高亮、图表占位
   */
  isStreaming?: boolean
  /**
   * 流式期间是否给每个新封口的 sealed 段落挂一次性淡入。
   * 仅影响 sealed 段的 wrapper；active tail 与终态单段不淡入。
   * 默认关闭，只有「逐段浮现」场景（思考块）开启。
   */
  chunkFade?: boolean
}

/** 内联组件运行时（解析器、组件与样式）只在回答里出现 openui 围栏时才加载，不占首屏体积 */
const InlineUiBlock = React.lazy(() =>
  import('../inline-ui/InlineUiBlock').then(module => ({ default: module.InlineUiBlock }))
)

/** openui 围栏：有交互作用域时渲染内联组件，否则回退为普通代码块 */
const OpenUiFence: React.FC<{ code: string; interactive: boolean }> = ({ code, interactive }) => {
  const scope = useInlineUiScope()
  const fallback = <CodeBlock language="openui" code={code} isStreaming={!interactive} />
  if (!scope) return fallback
  return (
    <React.Suspense fallback={null}>
      <InlineUiBlock scope={scope} code={code} interactive={interactive} fallback={fallback} />
    </React.Suspense>
  )
}

/**
 * 学习回复的「下一步推荐」围栏：有学习作用域时由回复下方的建议条渲染，正文不显示；
 * 流式中语言名还没写完（如 ```sugg）也先隐藏，避免闪出空代码块。
 */
const SuggestionsFence: React.FC<{ code: string; language: string; isStreaming: boolean }> = ({ code, language, isStreaming }) => {
  const scope = useInlineUiScope()
  if (scope) return null
  return <CodeBlock language={language} code={code} isStreaming={isStreaming} />
}

function isSuggestionsFence(lang: string, isStreaming: boolean): boolean {
  if (lang === LEARNING_SUGGESTIONS_FENCE) return true
  return isStreaming && lang.length >= 2 && LEARNING_SUGGESTIONS_FENCE.startsWith(lang)
}

/** 单块 Markdown 渲染单元；content 不变时 React.memo 短路，不重建 AST */
const MarkdownChunk = React.memo<{
  content: string
  components: MarkdownComponents
}>(function MarkdownChunk({ content, components }) {
  if (!content) return null
  return (
    <Markdown autolink="gfm" contentWidth="100%" components={components}>
      {content}
    </Markdown>
  )
})

/**
 * complete 组件集：sealed 块与终态共用。代码高亮开、图表渲染开。
 * 引用稳定（模块常量），MarkdownChunk 的 memo 不因组件集引用抖动失效。
 */
const COMPLETED_COMPONENTS: MarkdownComponents = {
  code({ code, language }) {
    const lang = (language ?? '').toLowerCase()
    if (lang === 'mermaid') {
      return <MermaidDiagram source={code} renderNow={true} />
    }
    if (MATH_FENCE_LANGUAGES.has(lang)) {
      return <MathFence code={code} />
    }
    if (lang === 'openui') {
      return <OpenUiFence code={code} interactive={true} />
    }
    if (isSuggestionsFence(lang, false)) {
      return <SuggestionsFence code={code} language={lang} isStreaming={false} />
    }
    return <CodeBlock language={lang} code={code} isStreaming={false} />
  },
  inlineCode({ children }) {
    return <MathInlineCode>{restoreTableCodePipes(children)}</MathInlineCode>
  },
  link({ href, children }) {
    if (!href || !isSafeMarkdownHref(href)) {
      return <span className="markdown-link-text">{children}</span>
    }
    return <MarkdownLink href={href}>{children}</MarkdownLink>
  }
}

/** streaming 组件集：active tail 专用。无高亮、图表占位；公式照常（便宜且缓存） */
const STREAMING_COMPONENTS: MarkdownComponents = {
  ...COMPLETED_COMPONENTS,
  code({ code, language }) {
    const lang = (language ?? '').toLowerCase()
    if (lang === 'mermaid') {
      return <MermaidDiagram source={code} renderNow={false} />
    }
    if (MATH_FENCE_LANGUAGES.has(lang)) {
      return <MathFence code={code} />
    }
    if (lang === 'openui') {
      return <OpenUiFence code={code} interactive={false} />
    }
    if (isSuggestionsFence(lang, true)) {
      return <SuggestionsFence code={code} language={lang} isStreaming={true} />
    }
    return <CodeBlock language={lang} code={code} isStreaming={true} />
  }
}

/** 测试用：累计「本帧重解析字符数」（仅 activeTail / 终态全文） */
let __markdownReparseChars = 0

/** 交给 Astryx 前的统一转译：数学定界符先变行内代码，再保护表格代码段内的竖线 */
function prepareMarkdown(raw: string): string {
  return protectTableCodePipes(transformMathSyntax(raw).text)
}
export function __takeMarkdownReparseChars(): number {
  const n = __markdownReparseChars
  __markdownReparseChars = 0
  return n
}

interface SealedCache {
  /** 内容身份（raw 空间）：会话切换 / 非流式重置时清空 */
  contentPrefix: string
  sealedEnd: number
  /** 已转译（mathSyntax）的封口块；内容冻结，引用稳定 */
  parts: string[]
  /** 上一帧未闭合 fence 起点，供增量扫描只扫后缀 */
  openFenceStart: number
  /** 上一帧 content.length，供 findOpenFenceStartIncremental */
  contentLength: number
}

const EMPTY_SEALED_CACHE: SealedCache = {
  contentPrefix: '',
  sealedEnd: 0,
  parts: [],
  openFenceStart: -1,
  contentLength: 0
}

export const MarkdownRenderer = React.memo<MarkdownRendererProps>(function MarkdownRenderer({
  content,
  isStreaming = false,
  chunkFade = false
}) {
  // 跨 render 累积已封口块：只追加，不回退；content 前缀不匹配时重置
  const sealedCacheRef = useRef<SealedCache>(EMPTY_SEALED_CACHE)

  if (!content) return null

  // 终态：整段一次解析 + 完整高亮；清空流式缓存
  if (!isStreaming) {
    sealedCacheRef.current = EMPTY_SEALED_CACHE
    const finalContent = prepareMarkdown(content)
    __markdownReparseChars += finalContent.length
    return (
      <div className="markdown-body">
        <MarkdownChunk content={finalContent} components={COMPLETED_COMPONENTS} />
      </div>
    )
  }

  // 流式增量：在已有 sealedEnd 基础上继续封口
  const cache = sealedCacheRef.current
  if (
    cache.sealedEnd > 0 &&
    (content.length < cache.sealedEnd || !content.startsWith(cache.contentPrefix))
  ) {
    // 内容被替换（attempt 重试等）：整段重来
    sealedCacheRef.current = EMPTY_SEALED_CACHE
  }

  const prev = sealedCacheRef.current
  const prevEnd = prev.sealedEnd
  const split = advanceIncrementalMarkdownBoundary(
    content,
    false,
    prevEnd,
    prev.contentLength,
    prev.openFenceStart
  )

  // 未闭合 $$ 块保护：封口不越过公式块起点（与 openFence 同语义）
  let sealTo = split.sealedEndOffset
  const mathOpen = findOpenDisplayMathStart(content, prevEnd)
  if (mathOpen >= 0 && sealTo > mathOpen) {
    sealTo = mathOpen
  }

  if (sealTo > prevEnd) {
    const transformed = prepareMarkdown(content.slice(prevEnd, sealTo))
    sealedCacheRef.current = {
      contentPrefix: content.slice(0, sealTo),
      sealedEnd: sealTo,
      parts: transformed.length > 0 ? [...prev.parts, transformed] : prev.parts,
      openFenceStart: split.openFenceStart,
      contentLength: content.length
    }
  } else {
    // sealed 未前进：仍更新 fence / 长度，供下一帧增量扫
    sealedCacheRef.current = {
      ...prev,
      openFenceStart: split.openFenceStart,
      contentLength: content.length
    }
  }

  const { parts: sealedParts, sealedEnd } = sealedCacheRef.current
  const activeTail = prepareMarkdown(content.slice(sealedEnd))
  __markdownReparseChars += content.length - sealedEnd

  return (
    <div className="markdown-body">
      {sealedParts.map((part, idx) => (
        <div
          key={`sealed-${idx}`}
          className={chunkFade ? 'md-sealed-chunk md-sealed-chunk--fade' : 'md-sealed-chunk'}
        >
          <MarkdownChunk content={part} components={COMPLETED_COMPONENTS} />
        </div>
      ))}
      {activeTail ? (
        <MarkdownChunk key="active-tail" content={activeTail} components={STREAMING_COMPONENTS} />
      ) : null}
    </div>
  )
})
