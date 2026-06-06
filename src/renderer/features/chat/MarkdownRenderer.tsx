/**
 * MarkdownRenderer — 模型文本输出的 Markdown 渲染器
 *
 * 职责：
 * 1. 通过 react-markdown + remark-gfm 渲染 CommonMark 与 GFM 扩展
 *    （表格 / 任务列表 / 删除线 / 自动链接 / 标题 / 列表 / 引用 / 链接）
 * 2. 代码块复用 syntaxHighlight 做 token 上色，右上角始终显示语言标签
 * 3. 代码块右上角提供"复制"按钮，复制成功后回写 ✓ 已复制
 * 4. 链接默认在新窗口打开，避免打断用户对话上下文
 *
 * Phase 5 优化：
 * - MARKDOWN_COMPONENTS 提升为模块级常量，引用稳定，配合 React.memo
 *   避免 react-markdown 每次 render 重建 AST
 * - CodeBlock 接受 isStreaming：流式期间跳过 highlightLine 逐行解析，
 *   改用纯文本展示，结束后再启用完整高亮
 */
import React, { Fragment, useCallback, useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyIcon, CheckIcon } from '../../components/Icons'
import { highlightLine } from '../diff/syntaxHighlight'
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

// 把 markdown 语言标签映射成 highlightLine 能识别的假文件后缀
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
        // 剪贴板权限被拒时静默忽略，避免弹出错误打断对话流
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
              {/*
                流式期间：跳过 highlightLine 逐行 token 解析，避免每 chunk 重新走词法分析。
                文本节点直接渲染，纯文本展示；不输出 diff-token span 类。
                流式结束后恢复正常高亮。
              */}
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
   * 是否处于流式生成中。流式期间代码块跳过语法高亮，避免每 chunk 重解析。
   * 默认 false。
   */
  isStreaming?: boolean
}

/**
 * 模块级 Markdown 组件映射表。
 *
 * 关键：引用稳定，React.memo 才能正确短路。
 * 之前内联对象每次 render 重建，导致 react-markdown 每次都全量重建 AST，
 * 在历史消息多时严重拖慢长循环渲染。
 *
 * 注意：pre / code / a / table 都是无状态组件，引用稳定；
 * 但 pre 需要捕获 isStreaming 决定是否走代码块高亮降级，因此实际传给
 * react-markdown 的 components 由组件内部 useMemo 拼装（见下）。
 */
const STATIC_MARKDOWN_COMPONENTS: Omit<Components, 'pre'> = {
  // 走到这里的都是 inline code（fence 已被 pre 拦截）
  code({ children, ...rest }) {
    // 只透传必要属性，避免 react-markdown 的 node 注入到 DOM
    const { node: _node, ...domSafe } = rest as { node?: unknown } & Record<string, unknown>
    return (
      <code className="markdown-inline-code" {...domSafe}>
        {children}
      </code>
    )
  },
  a({ children, href, ...rest }) {
    const { node: _node, ...domSafe } = rest as { node?: unknown } & Record<string, unknown>
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

/** 模块级 remark 插件数组，引用稳定 */
const REMARK_PLUGINS = [remarkGfm]

/**
 * 用 React.memo 包裹：流式生成期间，每个 text_delta 都会触发 ChatPanel 整体重渲染，
 * 若不做 memo，所有历史消息的 Markdown 都会被 react-markdown 重新解析、代码块逐行
 * 重新高亮，产生 O(消息数 × 内容量) 的解析/ DOM 开销，长循环下直接撑爆渲染进程
 * （Blink/Oilpan OOM 白屏）。content 为字符串，浅比较即可精确命中「内容未变则跳过」。
 */
export const MarkdownRenderer = React.memo<MarkdownRendererProps>(function MarkdownRenderer({ content, isStreaming = false }) {
  // 流式期间内层 code 组件已经通过 CodeBlock 的 isStreaming 跳过高亮；
  // 这里额外 memo remarkPlugins 防不必要的 prop 引用变化。
  const remarkPlugins = useMemo(() => REMARK_PLUGINS, [])

  // pre 组件需要捕获 isStreaming（决定 CodeBlock 走不走高亮降级路径），
  // 因此不能在模块级常量里固定。改在组件内 useMemo 拼装，把 isStreaming 闭包进去。
  // 当 isStreaming 翻转时，引用变化 → react-markdown 重建组件树 → 高亮路径正确切换。
  const components = useMemo<Components>(() => ({
    ...STATIC_MARKDOWN_COMPONENTS,
    pre({ node, children }) {
      const parsed = getCodeFromPreNode(node)
      if (!parsed) return <pre className="md-code-block__pre">{children}</pre>
      return <CodeBlock language={parsed.language} code={parsed.code} isStreaming={isStreaming} />
    }
  }), [isStreaming])

  if (!content) return null

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
