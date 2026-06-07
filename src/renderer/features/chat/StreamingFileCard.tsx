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
import { getToolSummary, countLines } from './toolDisplay'
import { parsePartialToolArgs } from './partialJsonArgs'
import './StreamingFileCard.css'

export interface StreamingFileCardProps {
  toolCallId: string
  toolName: 'write' | 'edit'
  status: 'running' | 'success' | 'error'
  /**
   * 工具参数原始 JSON 字符串（流式通道）。流式期间逐段增长，finalize 后被 store 删掉。
   * 与 args 互斥：流式期接这个，finalize 后改接 args。
   */
  argumentsRaw?: string
  /**
   * 已解析的完整 args（完整通道）。流式期上游用 argumentsRaw + parsePartialToolArgs 增量填充；
   * finalize 后由 store 写入完整对象。
   *
   * 兼容旧调用方：若既未传 argumentsRaw 也未传 args（外部已自行解析），可只传 args。
   */
  args?: Record<string, unknown>
  result?: string
}

/** 从 args 中提取预览文本：write 取 content，edit 取新内容 */
function getPreviewContent(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'write') {
    return (args.content as string) || ''
  }
  if (toolName === 'edit') {
    // 新格式：edits[].newText（可能多处替换，拼接展示）；
    // 流式/旧格式回退：newText / new。
    const edits = args.edits
    if (Array.isArray(edits)) {
      return edits
        .map(e => (e && typeof e === 'object' ? ((e as Record<string, unknown>).newText as string) ?? '' : ''))
        .filter(Boolean)
        .join('\n\n')
    }
    return (args.newText as string) || (args.new as string) || ''
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
  const [isOpen, setIsOpen] = useState(status === 'running')
  const userToggledRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const frameIdRef = useRef<number | null>(null)

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

  // 自动展开策略：running 默认展开；完成后不自动收起，避免用户阅读时视口跳动。
  useEffect(() => {
    if (status === 'running' && !userToggledRef.current) {
      setIsOpen(true)
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
          {lines.map((line, idx) => {
            return (
              <div key={idx} className="streaming-card__line">
                <span className="streaming-card__line-no">{idx + 1}</span>
                <span className="streaming-card__line-text">
                  {shouldHighlight
                    ? highlightLine(line, filePath).map((token, tIdx) => (
                        <span key={tIdx} className={`diff-token diff-token--${token.type}`}>{token.text}</span>
                      ))
                    : line}
                </span>
              </div>
            )
          })}

          {/* error 状态下展示错误信息 */}
          {status === 'error' && result && (
            <div className="streaming-card__error">{result}</div>
          )}
        </div>
      )}
    </div>
  )
})
