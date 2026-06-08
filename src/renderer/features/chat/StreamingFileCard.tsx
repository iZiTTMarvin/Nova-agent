/**
 * StreamingFileCard — 流式文件写入/修改实时卡片
 *
 * 职责：
 * 1. 在 write/edit 工具流式产出参数期间，展示实时进度卡片
 * 2. 等宽字体逐行刷出代码，带行号与语法高亮
 * 3. running 时自动展开并滚动到底部，完成后保持当前展开状态，避免页面突然塌陷
 * 4. 复用 DiffViewer 视觉语言：圆角边框、header 行高字体、状态徽章颜色
 *
 * 性能要点（Step 2）：
 * - props 接 argumentsRaw（字符串）而非已解析的 args 对象。
 *   字符串是 primitive，React.memo 浅比较天然稳定，
 *   上游 applyStreamDeltas 重建 block 时不会让本组件的 memo 失效。
 * - 内部用 useMemo + parsePartialToolArgs 容错解析到 args。
 * - running 阶段不做 token 级语法高亮（每帧少 200+ 次正则匹配），
 *   等 status 切到 success/error 才一次性高亮，
 *   思路与 MarkdownRenderer 的 isStreaming 降级一致。
 */
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { SpinnerIcon, CheckIcon, AlertIcon, ChevronIcon } from '../../components/Icons'
import { highlightLine } from '../diff/syntaxHighlight'
import { highlightLineCached } from '../../lib/highlightCache'
import { getToolSummary, countLines } from './toolDisplay'
import { parsePartialToolArgs } from './partialJsonArgs'
import { isContentSummary } from '../../../shared/tool-input-sanitizer'
import type { ContentSummary } from '../../../shared/tool-input-sanitizer'
import './StreamingFileCard.css'

/** T03：大文件预览行数上限，超过时截断展示 */
const PREVIEW_LINE_LIMIT = 240

/** StreamingFileCard 的公共字段（两条通道共享） */
interface StreamingFileCardBaseProps {
  toolCallId: string
  toolName: 'write' | 'edit'
  status: 'running' | 'success' | 'error'
  result?: string
}

/**
 * StreamingFileCard 的 props —— argumentsRaw / args 两条通道用 discriminated union 强制互斥。
 *
 * - 流式通道：只传 `argumentsRaw`（原始 JSON 字符串，逐段增长）。
 *   字符串是 primitive，浅比较稳定，React.memo 严格命中，避免上游每帧重建 args 对象触发的假重渲染。
 * - 完整通道：只传 `args`（已解析的完整对象）。finalize 时 store 删掉 block.argumentsRaw，
 *   调用方自动切到本通道，仅在那一次 prop 变化触发重渲染进入高亮路径。
 *
 * 用 union（而非两个 optional 字段）让 TypeScript 在编译期保证：
 * 两个通道不会同时出现、也不会同时缺失。谁误传两个，编译直接报错。
 */
export type StreamingFileCardProps =
  | (StreamingFileCardBaseProps & { argumentsRaw: string; args?: never })
  | (StreamingFileCardBaseProps & { argumentsRaw?: never; args: Record<string, unknown> })

/** 从可能是 ContentSummary 的值中提取预览文本（T03 兼容 T01 摘要化） */
function extractTextFromSummary(value: unknown): string {
  if (typeof value === 'string') return value
  if (isContentSummary(value)) {
    const s = value as ContentSummary
    return s.content_head + '\n\n... [摘要] ...\n\n' + s.content_tail
  }
  return ''
}

/** 从 args 中提取预览文本：write 取 content，edit 取新内容 */
function getPreviewContent(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'write') {
    return extractTextFromSummary(args.content)
  }
  if (toolName === 'edit') {
    const edits = args.edits
    if (Array.isArray(edits)) {
      return edits
        .map(e => {
          if (e && typeof e === 'object') {
            return extractTextFromSummary((e as Record<string, unknown>).newText)
          }
          return ''
        })
        .filter(Boolean)
        .join('\n\n')
    }
    return extractTextFromSummary(args.newText) || extractTextFromSummary(args.new) || ''
  }
  return ''
}

/** 从 args 中提取文件路径（兼容新 schema filePath 与旧 schema path） */
function getFilePath(args: Record<string, unknown>): string {
  return (args.filePath as string) || (args.path as string) || ''
}

/** 状态对应的徽章文本 */
function getStatusLabel(toolName: string, status: StreamingFileCardProps['status']): string {
  if (status === 'error') return '失败'
  if (toolName === 'write') return '新建'
  return '修改'
}

export const StreamingFileCard: React.FC<StreamingFileCardProps> = React.memo(function StreamingFileCard({
  toolName,
  status,
  argumentsRaw,
  args: argsProp,
  result
}) {
  // T03：默认折叠。running 时由 useEffect 自动展开；完成后自动折叠（除非用户手动操作过）
  const [isOpen, setIsOpen] = useState(false)
  const userToggledRef = useRef(false)
  // T03：大文件行数截断控制
  const [showFull, setShowFull] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const frameIdRef = useRef<number | null>(null)
  // T03：追踪上一次 status，用于检测 running → 完成态切换
  const prevStatusRef = useRef(status)

  // 优先用 argumentsRaw 自行 parsePartialToolArgs；
  // 仅当外部未传 argumentsRaw（兼容旧调用方）时回退到 args。
  // useMemo 依赖字符串引用：仅当 raw 真追加内容时才重算。
  const args = useMemo<Record<string, unknown>>(() => {
    if (argumentsRaw !== undefined) {
      return parsePartialToolArgs(toolName, argumentsRaw)
    }
    return argsProp ?? {}
    // argsProp 仅在 argumentsRaw 未传时使用，依赖里两个都列上保证行为一致
  }, [toolName, argumentsRaw, argsProp])

  const filePath = getFilePath(args)
  const previewContent = getPreviewContent(toolName, args)
  const lineCount = countLines(previewContent)
  const summary = getToolSummary(toolName, args)

  // T03：running 时自动展开；running → 完成态时自动折叠（除非用户手动展开过）
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status

    if (status === 'running' && !userToggledRef.current) {
      setIsOpen(true)
    } else if (prev === 'running' && status !== 'running' && !userToggledRef.current) {
      setIsOpen(false)
    }
  }, [status])

  // running 阶段自动滚动到底部，用 rAF 节流避免高频 layout
  const scheduleAutoScroll = useCallback(() => {
    if (frameIdRef.current !== null) return
    frameIdRef.current = requestAnimationFrame(() => {
      frameIdRef.current = null
      if (bodyRef.current) {
        bodyRef.current.scrollTop = bodyRef.current.scrollHeight
      }
    })
  }, [])

  const cancelAutoScroll = useCallback(() => {
    if (frameIdRef.current === null) return
    cancelAnimationFrame(frameIdRef.current)
    frameIdRef.current = null
  }, [])

  // 内容变化时触发滚动调度（scheduleAutoScroll 内部已有 frameIdRef 防重复）
  useEffect(() => {
    if (status === 'running' && isOpen) {
      scheduleAutoScroll()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewContent])

  // 状态或展开状态变化时取消自动滚动
  useEffect(() => {
    if (status !== 'running' || !isOpen) {
      cancelAutoScroll()
    }
    return () => cancelAutoScroll()
  }, [status, isOpen, cancelAutoScroll])

  const handleToggle = () => {
    userToggledRef.current = true
    setIsOpen(prev => !prev)
  }

  // split('\n') 在每帧重新执行都是一次 O(n) 字符串扫描+数组分配，
  // 用 useMemo 缓存；previewContent 引用未变时直接复用上一次的 lines 数组。
  const lines = useMemo(() => previewContent.split('\n'), [previewContent])
  // T03：大文件截断，只渲染前 PREVIEW_LINE_LIMIT 行
  const needsTruncation = lines.length > PREVIEW_LINE_LIMIT
  const displayLines = showFull ? lines : lines.slice(0, PREVIEW_LINE_LIMIT)
  // running 阶段不高亮：每帧少 N 次正则匹配（CSS 大文件 200+ 行常见）。
  // 与 MarkdownRenderer.tsx 的 isStreaming 降级思路一致。
  const shouldHighlight = status !== 'running'

  const statusLabel = getStatusLabel(toolName, status)
  const statusClass = status === 'running'
    ? 'streaming-card--running'
    : status === 'success'
      ? 'streaming-card--success'
      : 'streaming-card--error'

  return (
    <div className={`streaming-card ${statusClass}`}>
      <div className="streaming-card__header" onClick={handleToggle}>
        <div className="streaming-card__status-icon">
          {status === 'running' && (
            <div className="streaming-card__spinner">
              <SpinnerIcon size={14} />
            </div>
          )}
          {status === 'success' && <CheckIcon size={14} />}
          {status === 'error' && <AlertIcon size={14} />}
        </div>

        <span className="streaming-card__filename" title={filePath}>
          {filePath || '未命名文件'}
        </span>

        <span className="streaming-card__status-badge">{statusLabel}</span>

        <span className="streaming-card__line-count">
          {lineCount > 0 && `${lineCount} 行`}
        </span>

        <div className="streaming-card__arrow">
          <ChevronIcon size={14} direction={isOpen ? 'up' : 'down'} />
        </div>
      </div>

      {isOpen && (
        <div className="streaming-card__body" ref={bodyRef}>
          {displayLines.map((line, idx) => {
            return (
              <div key={idx} className="streaming-card__line">
                <span className="streaming-card__line-no">{idx + 1}</span>
                <span className="streaming-card__line-text">
                  {shouldHighlight
                    ? highlightLineCached(line, filePath, highlightLine).map((token, tIdx) => (
                        <span key={tIdx} className={`diff-token diff-token--${token.type}`}>{token.text}</span>
                      ))
                    : line}
                </span>
              </div>
            )
          })}

          {/* T03：截断提示行 */}
          {needsTruncation && !showFull && (
            <div className="streaming-card__truncation-hint" onClick={() => setShowFull(true)}>
              还有 {lines.length - PREVIEW_LINE_LIMIT} 行未显示，点击展开全部
            </div>
          )}
          {needsTruncation && showFull && (
            <div className="streaming-card__truncation-hint" onClick={() => setShowFull(false)}>
              点击折叠
            </div>
          )}

          {/* error 状态下展示错误信息 */}
          {status === 'error' && result && (
            <div className="streaming-card__error">{result}</div>
          )}
        </div>
      )}
    </div>
  )
})
