/**
 * MarkdownRenderer — 模型文本输出的 Markdown 渲染器
 *
 * 职责：
 * 1. 通过 react-markdown + remark-gfm 渲染 CommonMark 与 GFM 扩展
 * 2. 代码块复用 syntaxHighlight；流式期间跳过逐行高亮
 * 3. 两阶段增量：已封口 prefix blocks（解析一次冻结）+ 活动 tail（只重解析尾部）
 *
 * ⚠️ 禁止只叠 React.memo 但仍每帧对完整 content 跑 ReactMarkdown。
 */
import React, { Fragment, useCallback, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyIcon, CheckIcon } from '../../components/Icons'
import { highlightLine } from '../diff/syntaxHighlight'
import { isSafeMarkdownHref } from './safeMarkdownLink'
import { splitIncrementalMarkdown } from './incrementalMarkdown'
import './MarkdownRenderer.css'

// hast 节点的最小结构，避免引入 @types/hast 这一额外依赖
interface HastTextNode {
  type: 'text'
  value: string
}
interface HastElementNode {
  type: 'element'
  tagName?: string
  properties?: { className?: string[] | string }
  children?: Array<HastElementNode | HastTextNode>
}

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
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1800)
      },
      () => {
        // 剪贴板权限被拒时静默忽略
      }
    )
  }, [code])

  const fakePath = langToFakePath(language)
  const lines = code.split('\n')

  return (
    <div className="md-code-block">
      <div className="md-code-block__header">
        <span className="md-code-block__lang">{language || 'text'}</span>
        <button
          type="button"
          className="md-code-block__copy"
          onClick={handleCopy}
          title="复制代码"
        >
          {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="md-code-block__pre">
        <code>
          {lines.map((line, idx) => (
            <Fragment key={idx}>
              {idx > 0 && '\n'}
              {isStreaming ? line : highlightLine(line, fakePath).map((token, tIdx) => (
                <span key={tIdx} className={`diff-token diff-token--${token.type}`}>
                  {token.text}
                </span>
              ))}
            </Fragment>
          ))}
        </code>
      </pre>
    </div>
  )
}

function getCodeFromPreNode(node: unknown): { language: string; code: string } | null {
  const root = node as HastElementNode | undefined
  const codeNode = root?.children?.find(
    (c): c is HastElementNode => (c as HastElementNode).type === 'element' && (c as HastElementNode).tagName === 'code'
  )
  if (!codeNode) return null

  const rawClassNames = codeNode.properties?.className
  const classList = Array.isArray(rawClassNames)
    ? rawClassNames
    : typeof rawClassNames === 'string'
      ? rawClassNames.split(/\s+/)
      : []
  const langClass = classList.find(c => c.startsWith('language-'))
  const language = langClass ? langClass.slice('language-'.length) : ''
  const code = (codeNode.children || [])
    .map(c => (c.type === 'text' ? c.value : ''))
    .join('')
    .replace(/\n$/, '')
  return { language, code }
}

interface MarkdownRendererProps {
  content: string
  /**
   * 是否处于流式生成中。流式期间：
   * - 走两阶段增量（sealed + tail），避免全文重解析
   * - 代码块跳过语法高亮
   */
  isStreaming?: boolean
}

const STATIC_MARKDOWN_COMPONENTS: Omit<Components, 'pre'> = {
  code({ children, ...rest }) {
    const { node: _node, ...domSafe } = rest as { node?: unknown } & Record<string, unknown>
    return (
      <code className="markdown-inline-code" {...domSafe}>
        {children}
      </code>
    )
  },
  a({ children, href, ...rest }) {
    const { node: _node, ...domSafe } = rest as { node?: unknown } & Record<string, unknown>
    if (!isSafeMarkdownHref(href)) {
      return <span className="markdown-link-text">{children}</span>
    }
    return (
      <a
        className="markdown-link"
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        {...domSafe}
      >
        {children}
      </a>
    )
  },
  table({ children }) {
    return (
      <div className="markdown-table-wrap">
        <table className="markdown-table">{children}</table>
      </div>
    )
  }
}

const REMARK_PLUGINS = [remarkGfm]

/** 单块 Markdown 解析单元；content 不变时 React.memo 短路，不再重建 AST */
const MarkdownChunk = React.memo<{
  content: string
  isStreaming: boolean
  remarkPlugins: typeof REMARK_PLUGINS
  components: Components
}>(function MarkdownChunk({ content, remarkPlugins, components }) {
  if (!content) return null
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
      {content}
    </ReactMarkdown>
  )
})

/** 测试用：累计「本帧重解析字符数」（仅 activeTail / 终态全文） */
let __markdownReparseChars = 0
export function __takeMarkdownReparseChars(): number {
  const n = __markdownReparseChars
  __markdownReparseChars = 0
  return n
}

interface SealedCache {
  /** 内容身份：会话切换 / 非流式重置时清空 */
  contentPrefix: string
  sealedEnd: number
  parts: string[]
}

export const MarkdownRenderer = React.memo<MarkdownRendererProps>(function MarkdownRenderer({
  content,
  isStreaming = false
}) {
  const remarkPlugins = useMemo(() => REMARK_PLUGINS, [])

  const components = useMemo<Components>(() => ({
    ...STATIC_MARKDOWN_COMPONENTS,
    pre({ node, children }) {
      const parsed = getCodeFromPreNode(node)
      if (!parsed) return <pre className="md-code-block__pre">{children}</pre>
      return <CodeBlock language={parsed.language} code={parsed.code} isStreaming={isStreaming} />
    }
  }), [isStreaming])

  // 跨 render 累积已封口块：只追加，不回退；content 前缀不匹配时重置
  const sealedCacheRef = useRef<SealedCache>({ contentPrefix: '', sealedEnd: 0, parts: [] })

  if (!content) return null

  // 终态：整段一次解析 + 完整高亮；清空流式缓存
  if (!isStreaming) {
    sealedCacheRef.current = { contentPrefix: '', sealedEnd: 0, parts: [] }
    __markdownReparseChars += content.length
    return (
      <div className="markdown-body">
        <MarkdownChunk
          content={content}
          isStreaming={false}
          remarkPlugins={remarkPlugins}
          components={components}
        />
      </div>
    )
  }

  // 流式增量：在已有 sealedEnd 基础上继续封口
  const cache = sealedCacheRef.current
  if (cache.sealedEnd > 0 && !content.startsWith(cache.contentPrefix.slice(0, Math.min(cache.sealedEnd, cache.contentPrefix.length)))) {
    // 内容被替换（attempt 重试等）：整段重来
    sealedCacheRef.current = { contentPrefix: '', sealedEnd: 0, parts: [] }
  }

  const prevEnd = sealedCacheRef.current.sealedEnd
  const split = splitIncrementalMarkdown(content, false, prevEnd)

  if (split.sealedEndOffset > prevEnd) {
    const newlySealed = content.slice(prevEnd, split.sealedEndOffset)
    // 新封口段按空行切块追加；已有 parts 保持引用稳定
    const newParts = splitIncrementalMarkdown(newlySealed, true).sealedParts
    sealedCacheRef.current = {
      contentPrefix: content.slice(0, split.sealedEndOffset),
      sealedEnd: split.sealedEndOffset,
      parts: [...sealedCacheRef.current.parts, ...newParts.filter(p => p.length > 0)]
    }
  } else if (sealedCacheRef.current.contentPrefix.length === 0 && split.sealedEndOffset === 0) {
    sealedCacheRef.current.contentPrefix = content
  }

  const { parts: sealedParts } = sealedCacheRef.current
  const activeTail = content.slice(sealedCacheRef.current.sealedEnd)
  __markdownReparseChars += activeTail.length

  return (
    <div className="markdown-body markdown-body--incremental">
      {sealedParts.map((part, idx) => (
        <MarkdownChunk
          key={`sealed-${idx}`}
          content={part}
          isStreaming={true}
          remarkPlugins={remarkPlugins}
          components={components}
        />
      ))}
      {activeTail ? (
        <MarkdownChunk
          key="active-tail"
          content={activeTail}
          isStreaming={true}
          remarkPlugins={remarkPlugins}
          components={components}
        />
      ) : null}
    </div>
  )
})
