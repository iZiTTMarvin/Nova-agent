/**
 * MarkdownRenderer — 模型文本输出的 Markdown 渲染器（Astryx 内核）
 *
 * 职责分层（迁内核、保流式算法）：
 * 1. 流式算法仍是 Nova 两阶段增量（sealed + tail，splitIncrementalMarkdown）：
 *    已封口 prefix 冻结只渲染一次，活动 tail 每帧低成本重解析。打字机节奏、
 *    暂停、后台降频由 StreamingTextBlock + render pool 拥有，本组件不引入
 *    第二份放出状态（Astryx <Markdown isStreaming> 的内置平滑因此不使用）。
 * 2. 解析/渲染引擎换成 Astryx <Markdown>（替代 react-markdown + remark-gfm）：
 *    每块以非流式模式同步全量渲染，无内部动画，语义与旧 ReactMarkdown 块一致；
 *    prose 排版（字号/行高/间距）自此走 theme typography token。
 * 3. 代码块保留 Nova CodeBlock：羊皮纸暖底 + 复制按钮 + highlightLine；
 *    流式期间跳过逐行高亮（不变量，唯一终态高亮路径）。
 * 4. 链接保留 isSafeMarkdownHref 安全语义（unsafe → 纯文本）；
 *    autolink="gfm" 对齐原 remark-gfm 的裸 URL 自动链接行为。
 */
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Markdown } from '@astryxdesign/core/Markdown'
import type { MarkdownComponents } from '@astryxdesign/core/Markdown'
import { CopyIcon, CheckIcon } from '../../components/Icons'
import { highlightLine } from '../diff/syntaxHighlight'
import { isSafeMarkdownHref } from './safeMarkdownLink'
import { splitIncrementalMarkdown } from './incrementalMarkdown'
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
        <Button
          label={copied ? '已复制' : '复制'}
          variant="ghost"
          size="sm"
          icon={copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
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
              {isStreaming ? line : highlightLine(line, fakePath).map((token, tIdx) => (
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
   * - 代码块跳过语法高亮
   */
  isStreaming?: boolean
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
  /** 上一帧未闭合 fence 起点，供增量扫描只扫后缀 */
  openFenceStart: number
  /** 上一帧 content.length，供 findOpenFenceStartIncremental */
  contentLength: number
}

export const MarkdownRenderer = React.memo<MarkdownRendererProps>(function MarkdownRenderer({
  content,
  isStreaming = false
}) {
  // components 随 isStreaming 重建：保证流式/终态切换时高亮门控立即生效
  const components = useMemo<MarkdownComponents>(
    () => ({
      code({ code, language }) {
        return <CodeBlock language={language ?? ''} code={code} isStreaming={isStreaming} />
      },
      link({ href, children }) {
        if (!isSafeMarkdownHref(href)) {
          return <span className="markdown-link-text">{children}</span>
        }
        return (
          <a className="markdown-link" href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        )
      }
    }),
    [isStreaming]
  )

  // 跨 render 累积已封口块：只追加，不回退；content 前缀不匹配时重置
  const sealedCacheRef = useRef<SealedCache>({
    contentPrefix: '',
    sealedEnd: 0,
    parts: [],
    openFenceStart: -1,
    contentLength: 0
  })

  if (!content) return null

  // 终态：整段一次解析 + 完整高亮；清空流式缓存
  if (!isStreaming) {
    sealedCacheRef.current = {
      contentPrefix: '',
      sealedEnd: 0,
      parts: [],
      openFenceStart: -1,
      contentLength: 0
    }
    __markdownReparseChars += content.length
    return (
      <div className="markdown-body">
        <MarkdownChunk content={content} components={components} />
      </div>
    )
  }

  // 流式增量：在已有 sealedEnd 基础上继续封口
  const cache = sealedCacheRef.current
  if (cache.sealedEnd > 0 && !content.startsWith(cache.contentPrefix.slice(0, Math.min(cache.sealedEnd, cache.contentPrefix.length)))) {
    // 内容被替换（attempt 重试等）：整段重来
    sealedCacheRef.current = {
      contentPrefix: '',
      sealedEnd: 0,
      parts: [],
      openFenceStart: -1,
      contentLength: 0
    }
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

  if (split.sealedEndOffset > prevEnd) {
    const newlySealed = content.slice(prevEnd, split.sealedEndOffset)
    // 新封口段按空行切块追加；已有 parts 保持引用稳定
    const newParts = splitIncrementalMarkdown(newlySealed, true).sealedParts
    sealedCacheRef.current = {
      contentPrefix: content.slice(0, split.sealedEndOffset),
      sealedEnd: split.sealedEndOffset,
      parts: [...sealedCacheRef.current.parts, ...newParts.filter(p => p.length > 0)],
      openFenceStart: split.openFenceStart,
      contentLength: content.length
    }
  } else {
    // sealed 未前进：仍更新 fence / 长度，供下一帧增量扫
    sealedCacheRef.current = {
      ...sealedCacheRef.current,
      openFenceStart: split.openFenceStart,
      contentLength: content.length,
      contentPrefix:
        sealedCacheRef.current.contentPrefix.length === 0 && split.sealedEndOffset === 0
          ? content
          : sealedCacheRef.current.contentPrefix
    }
  }

  const { parts: sealedParts } = sealedCacheRef.current
  const activeTail = content.slice(sealedCacheRef.current.sealedEnd)
  __markdownReparseChars += activeTail.length

  return (
    <div className="markdown-body">
      {sealedParts.map((part, idx) => (
        <MarkdownChunk key={`sealed-${idx}`} content={part} components={components} />
      ))}
      {activeTail ? (
        <MarkdownChunk key="active-tail" content={activeTail} components={components} />
      ) : null}
    </div>
  )
})
