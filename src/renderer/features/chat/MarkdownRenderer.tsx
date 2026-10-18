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
 * 3. 数学语法走转译路线（mathSyntax）：Astryx 段落文本吃反斜杠，LaTeX 源码
 *    必须转成 ```math 围栏 / `$...$` 行内代码才能保真到达渲染层。
 * 4. 链接保留 isSafeMarkdownHref 安全语义（unsafe → 纯文本）；
 *    autolink="gfm" 对齐原 remark-gfm 的裸 URL 自动链接行为。
 */
import React, { useCallback, useRef } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Markdown } from '@astryxdesign/core/Markdown'
import type { MarkdownComponents } from '@astryxdesign/core/Markdown'
import { CopyIcon, CheckIcon } from '../../components/Icons'
import { useCopyFeedback } from '../../hooks/useCopyFeedback'
import { highlightLineCached } from '../../lib/highlightCache'
import { highlightLine } from '../diff/syntaxHighlight'
import { MarkdownLink } from './MarkdownLink'
import { isSafeMarkdownHref } from './safeMarkdownLink'
import { splitIncrementalMarkdown } from './incrementalMarkdown'
import { findOpenDisplayMathStart, transformMathSyntax } from './mathSyntax'
import { MathFence, MathInlineCode, MATH_FENCE_LANGUAGES } from './MathBlock'
import { MermaidDiagram } from './MermaidDiagram'
import './MarkdownRenderer.css'

const LANG_EXT_MAP: Record<string, string> = {
  typescript: 'ts',
  ts: 'ts',
  javascript: 'js',
  js: 'js',
  tsx: 'tsx',
  jsx: 'jsx',
  bash: 'sh',
  shell: 'sh',
  sh: 'sh',
  json: 'json',
  md: 'md',
  markdown: 'md',
  css: 'css',
  html: 'html'
}

function langToFakePath(language: string): string {
  if (!language) return ''
  const ext = LANG_EXT_MAP[language.toLowerCase()]
  return ext ? `code.${ext}` : ''
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

  const fakePath = langToFakePath(language)
  const lines = code.split('\n')

  return (
    <div className="md-code-block">
      <div className="md-code-block__header">
        <span className="md-code-block__lang">{language || 'text'}</span>
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
          className="md-code-block__copy"
          onClick={handleCopy}
          tooltip="复制代码"
        />
      </div>
      <pre className="md-code-block__pre">
        <code>
          {lines.map((line, idx) => (
            <React.Fragment key={idx}>
              {idx > 0 && '\n'}
              {isStreaming ? line : highlightLineCached(line, fakePath, highlightLine).map((token, tIdx) => (
                <span key={tIdx} className={`diff-token diff-token--${token.type}`}>
                  {token.text}
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
    return <CodeBlock language={lang} code={code} isStreaming={false} />
  },
  inlineCode({ children }) {
    return <MathInlineCode>{children}</MathInlineCode>
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
    return <CodeBlock language={lang} code={code} isStreaming={true} />
  }
}

/** 测试用：累计「本帧重解析字符数」（仅 activeTail / 终态全文） */
let __markdownReparseChars = 0
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
    const finalContent = transformMathSyntax(content).text
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
    !content.startsWith(cache.contentPrefix.slice(0, Math.min(cache.sealedEnd, cache.contentPrefix.length)))
  ) {
    // 内容被替换（attempt 重试等）：整段重来
    sealedCacheRef.current = EMPTY_SEALED_CACHE
  }

  const prev = sealedCacheRef.current
  const prevEnd = prev.sealedEnd
  const split = splitIncrementalMarkdown(
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
    const { text: transformed } = transformMathSyntax(content.slice(prevEnd, sealTo))
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
  const activeTail = transformMathSyntax(content.slice(sealedEnd)).text
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
