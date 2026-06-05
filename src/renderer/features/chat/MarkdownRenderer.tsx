/**
 * MarkdownRenderer — 模型文本输出的 Markdown 渲染器
 *
 * 职责：
 * 1. 通过 react-markdown + remark-gfm 渲染 CommonMark 与 GFM 扩展
 *    （表格 / 任务列表 / 删除线 / 自动链接 / 标题 / 列表 / 引用 / 链接）
 * 2. 代码块复用 syntaxHighlight 做 token 上色，右上角始终显示语言标签
 * 3. 代码块右上角提供"复制"按钮，复制成功后回写 ✓ 已复制
 * 4. 链接默认在新窗口打开，避免打断用户对话上下文
 */
import React, { Fragment, useCallback, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyIcon, CheckIcon } from '../../components/Icons'
import { highlightLine } from '../diff/syntaxHighlight'
import './MarkdownRenderer.css'

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
}

const CodeBlock: React.FC<CodeBlockProps> = ({ language, code }) => {
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
              {highlightLine(line, fakePath).map((token, tIdx) => (
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
}

/**
 * 用 React.memo 包裹：流式生成期间，每个 text_delta 都会触发 ChatPanel 整体重渲染，
 * 若不做 memo，所有历史消息的 Markdown 都会被 react-markdown 重新解析、代码块逐行
 * 重新高亮，产生 O(消息数 × 内容量) 的解析/ DOM 开销，长循环下直接撑爆渲染进程
 * （Blink/Oilpan OOM 白屏）。content 为字符串，浅比较即可精确命中「内容未变则跳过」。
 */
export const MarkdownRenderer = React.memo<MarkdownRendererProps>(function MarkdownRenderer({ content }) {
  if (!content) return null

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // fence 代码块在 hast 中是 pre > code 结构，这里截获后交给 CodeBlock 处理
          pre({ node, children }) {
            const parsed = getCodeFromPreNode(node)
            if (!parsed) return <pre className="md-code-block__pre">{children}</pre>
            return <CodeBlock language={parsed.language} code={parsed.code} />
          },
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
