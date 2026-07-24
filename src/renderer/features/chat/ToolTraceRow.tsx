/**
 * ToolTraceRow — L3 等宽原子行
 *
 * 默认只渲染 [Action] [Target] 一行；点击后才挂载 L4（参数/结果/文件预览）。
 * 权限放行条始终挂在行下（冒泡），不依赖 L4 展开。
 */
import React, { useMemo, useState } from 'react'
import { ChevronIcon } from '../../components/Icons'
import { isPermissionDeniedResult } from './renderingPolicy'
import { getToolTraceAction, getToolTraceTarget, getFileToolPreviewText } from './toolTraceDisplay'
import { clampBashShellOutputForDisplay } from './bashOutputDisplay'
import { parsePartialToolArgs } from './partialJsonArgs'
import { useAgentStore } from '../../stores/useAgentStore'
import { InlinePermissionBar } from '../permissions/InlinePermissionBar'
import { WebSearchCard } from './WebSearchCard'
import type { PendingPermissionRequest } from '../../stores/types'
import './ToolTraceRow.css'

export interface ToolTraceRowProps {
  toolCallId?: string
  name: string
  args?: Record<string, unknown>
  /** 流式 write/edit：原始 JSON 字符串，primitive 便于 memo */
  argumentsRaw?: string
  status: 'running' | 'success' | 'error'
  result?: string
  isLiveStreaming?: boolean
}

/** 兼容既有测试：流式入场已改为纯 CSS，常量仅作门控文档 */
export const LIVE_ENTER_SPRING = { type: 'spring' as const, stiffness: 300, damping: 30, mass: 0.8 }
export const NO_ANIMATION = { duration: 0 }

function selectAnchoredRequest(
  request: PendingPermissionRequest | null,
  toolCallId: string | undefined
): PendingPermissionRequest | null {
  if (!request || !toolCallId) return null
  const ids = request.toolCallIds
  if (!ids || ids.length === 0) return null
  return ids[ids.length - 1] === toolCallId ? request : null
}

function StatusDot({ status }: { status: ToolTraceRowProps['status'] }) {
  return (
    <span
      className={`tool-trace-row__dot tool-trace-row__dot--${status}`}
      aria-hidden="true"
    />
  )
}

/** L4：仅在展开时挂载的重内容 */
function ToolTraceDetail({
  name,
  args,
  status,
  result
}: {
  name: string
  args: Record<string, unknown>
  status: ToolTraceRowProps['status']
  result?: string
}) {
  const shouldHideArguments = isPermissionDeniedResult(result)
  const isFileTool = name === 'write' || name === 'edit' || name === 'save_plan'
  const filePreview = isFileTool ? getFileToolPreviewText(name, args) : ''

  const bashDisplay = useMemo(() => {
    if (name !== 'bash' || !result) return null
    return clampBashShellOutputForDisplay(result)
  }, [name, result])

  return (
    <div className="tool-trace-row__detail">
      {isFileTool && filePreview && (
        <pre className="tool-trace-row__pre">{filePreview}</pre>
      )}

      {!isFileTool && !shouldHideArguments && Object.keys(args).length > 0 && (
        <div className="tool-trace-row__section">
          <div className="tool-trace-row__sec-title">参数</div>
          <pre className="tool-trace-row__pre">{JSON.stringify(args, null, 2)}</pre>
        </div>
      )}

      {result && (
        <div className="tool-trace-row__section">
          <div className="tool-trace-row__sec-title">结果</div>
          {name === 'web_search' ? (
            <WebSearchCard output={result} />
          ) : name === 'bash' && bashDisplay ? (
            <>
              {bashDisplay.truncated && (
                <div className="tool-trace-row__hint">
                  输出过长，已省略前 {bashDisplay.omittedChars.toLocaleString()} 个字符（展示末尾{' '}
                  {bashDisplay.text.length.toLocaleString()} 字）
                </div>
              )}
              <pre className="tool-trace-row__pre">{bashDisplay.text}</pre>
            </>
          ) : (
            <pre className="tool-trace-row__pre">{result}</pre>
          )}
        </div>
      )}

      {name === 'web_search' && status === 'running' && !result && (
        <div className="tool-trace-row__section">
          <div className="tool-trace-row__sec-title">结果</div>
          <WebSearchCard output="" loading />
        </div>
      )}

      {status === 'error' && !result && (
        <div className="tool-trace-row__hint tool-trace-row__hint--error">执行失败</div>
      )}
    </div>
  )
}

function areTracePropsEqual(prev: ToolTraceRowProps, next: ToolTraceRowProps): boolean {
  return (
    prev.toolCallId === next.toolCallId &&
    prev.name === next.name &&
    prev.status === next.status &&
    prev.result === next.result &&
    prev.isLiveStreaming === next.isLiveStreaming &&
    prev.argumentsRaw === next.argumentsRaw &&
    // args 引用稳定时跳过：store 只替换变更 block，其它行 args 同引用
    prev.args === next.args
  )
}

export const ToolTraceRow: React.FC<ToolTraceRowProps> = React.memo(function ToolTraceRow({
  toolCallId,
  name,
  args: argsProp,
  argumentsRaw,
  status,
  result,
  isLiveStreaming = false
}) {
  const [isOpen, setIsOpen] = useState(false)

  const args = useMemo<Record<string, unknown>>(() => {
    if (argumentsRaw !== undefined) {
      return parsePartialToolArgs(name, argumentsRaw)
    }
    return argsProp ?? {}
  }, [name, argumentsRaw, argsProp])

  const action = getToolTraceAction(name)
  const target = getToolTraceTarget(name, args)

  const anchoredRequest = useAgentStore(state =>
    selectAnchoredRequest(state.pendingPermissionRequest, toolCallId)
  )

  const rootClass = [
    'tool-trace-row',
    isLiveStreaming ? 'tool-trace-row--live' : '',
    status === 'error' ? 'tool-trace-row--error' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass}>
      <button
        type="button"
        className="tool-trace-row__header"
        onClick={() => setIsOpen(prev => !prev)}
        aria-expanded={isOpen}
      >
        <StatusDot status={status} />
        <span className="tool-trace-row__action">{action}</span>
        <span className="tool-trace-row__target" title={target}>
          {target}
        </span>
        <ChevronIcon
          size={12}
          direction={isOpen ? 'down' : 'right'}
          className="tool-trace-row__chevron"
        />
      </button>

      {/* L4：仅展开时挂载，避免默认渲染大段 result / 参数 DOM */}
      {isOpen && (
        <ToolTraceDetail name={name} args={args} status={status} result={result} />
      )}

      {anchoredRequest && (
        <div className="tool-trace-row__permission">
          <InlinePermissionBar request={anchoredRequest} />
        </div>
      )}
    </div>
  )
}, areTracePropsEqual)
