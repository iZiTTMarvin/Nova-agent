/**
 * StreamingFileCard — 流式文件写入/修改实时卡片
 *
 * 职责：
 * 1. 在 write/edit 工具流式产出参数期间，展示实时进度卡片
 * 2. 等宽字体逐行刷出代码，带行号与语法高亮
 * 3. running 时自动展开并滚动到底部，完成后自动收起（用户手动操作优先）
 * 4. 复用 DiffViewer 视觉语言：圆角边框、header 行高字体、状态徽章颜色
 */
import React, { useEffect, useRef, useState, useCallback } from 'react'
import { SpinnerIcon, CheckIcon, AlertIcon, ChevronIcon } from '../../components/Icons'
import { highlightLine } from '../diff/syntaxHighlight'
import { getToolSummary, countLines } from './toolDisplay'
import './StreamingFileCard.css'

interface StreamingFileCardProps {
  toolCallId: string
  toolName: 'write' | 'edit'
  status: 'running' | 'success' | 'error'
  args: Record<string, unknown>
  result?: string
}

/** 从 args 中提取预览文本：write 取 content，edit 取 new */
function getPreviewContent(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'write') {
    return (args.content as string) || ''
  }
  if (toolName === 'edit') {
    return (args.new as string) || ''
  }
  return ''
}

/** 从 args 中提取文件路径 */
function getFilePath(args: Record<string, unknown>): string {
  return (args.path as string) || ''
}

/** 状态对应的徽章文本 */
function getStatusLabel(toolName: string, status: StreamingFileCardProps['status']): string {
  if (status === 'error') return '失败'
  if (toolName === 'write') return '新建'
  return '修改'
}

export const StreamingFileCard: React.FC<StreamingFileCardProps> = ({
  toolName,
  status,
  args,
  result
}) => {
  const [isOpen, setIsOpen] = useState(status === 'running')
  const userToggledRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const frameIdRef = useRef<number | null>(null)

  const filePath = getFilePath(args)
  const previewContent = getPreviewContent(toolName, args)
  const lineCount = countLines(previewContent)
  const summary = getToolSummary(toolName, args)

  // 自动展开/收起策略：running 默认展开，完成后自动收起；用户手动操作后不再覆盖
  useEffect(() => {
    if (!userToggledRef.current) {
      setIsOpen(status === 'running')
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

  const lines = previewContent.split('\n')

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
            const tokens = highlightLine(line, filePath)
            return (
              <div key={idx} className="streaming-card__line">
                <span className="streaming-card__line-no">{idx + 1}</span>
                <span className="streaming-card__line-text">
                  {tokens.map((token, tIdx) => (
                    <span key={tIdx} className={`diff-token diff-token--${token.type}`}>{token.text}</span>
                  ))}
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
}
