/**
 * ToolTraceRow — L3 原子过程行
 *
 * 与 ToolCallGroup 时间线保持一致的中文动词、文件扩展名徽标与分层排版；
 * 点击整行展开 L4 详情（参数/结果/文件预览）。
 */
import React, { useMemo, useRef, useState } from 'react'
import {
  ChevronIcon,
  FileIcon,
  FolderIcon,
  SearchIcon,
  TerminalIcon
} from '../../components/Icons'
import { isPermissionDeniedResult } from './renderingPolicy'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useFileTreeStore } from '../inspector/useFileTreeStore'
import {
  compactPathForTrace,
  getToolTraceActionChinese,
  getToolTraceTarget,
  getFileToolPreviewText,
  splitFilePath
} from './toolTraceDisplay'
import { clampBashShellOutputForDisplay } from './bashOutputDisplay'
import { parsePartialToolArgs } from '../../lib/partialJsonArgs'
import { useAgentStore } from '../../stores/useAgentStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { InlinePermissionBar } from '../permissions/InlinePermissionBar'
import { WebSearchCard } from './WebSearchCard'
import { TurnProcessCollapsible } from './TurnProcessCollapsible'
import type { NestedToolActivity, PendingPermissionRequest } from '../../stores/types'
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
  /** run_code 沙箱内的嵌套工具活动：行下紧凑展示，不占顶级轨道 */
  nestedActivities?: NestedToolActivity[]
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

function TraceFileBadgeOrIcon({
  toolName,
  ext
}: {
  toolName: string
  ext: string
}) {
  if (toolName === 'ls') {
    return <FolderIcon size={12} className="tool-trace-row__icon tool-trace-row__icon--folder" />
  }
  if (toolName === 'grep' || toolName === 'find' || toolName === 'web_search') {
    return <SearchIcon size={12} className="tool-trace-row__icon" />
  }
  if (toolName === 'bash') {
    return <TerminalIcon size={12} className="tool-trace-row__icon" />
  }

  const normalizedExt = ext.toLowerCase()
  if (normalizedExt === 'ts' || normalizedExt === 'mts' || normalizedExt === 'cts') {
    return <span className="file-badge file-badge--ts">TS</span>
  }
  if (normalizedExt === 'tsx') {
    return <span className="file-badge file-badge--tsx">TSX</span>
  }
  if (normalizedExt === 'js' || normalizedExt === 'mjs' || normalizedExt === 'cjs') {
    return <span className="file-badge file-badge--js">JS</span>
  }
  if (normalizedExt === 'jsx') {
    return <span className="file-badge file-badge--jsx">JSX</span>
  }
  if (normalizedExt === 'json') {
    return <span className="file-badge file-badge--json">JSON</span>
  }
  if (normalizedExt === 'md' || normalizedExt === 'markdown') {
    return <span className="file-badge file-badge--md">MD</span>
  }
  if (normalizedExt === 'py') {
    return <span className="file-badge file-badge--py">PY</span>
  }
  if (normalizedExt === 'css' || normalizedExt === 'scss' || normalizedExt === 'less') {
    return <span className="file-badge file-badge--css">CSS</span>
  }
  if (normalizedExt === 'html') {
    return <span className="file-badge file-badge--html">HTML</span>
  }
  if (normalizedExt) {
    return <span className="file-badge file-badge--generic">{normalizedExt.slice(0, 3).toUpperCase()}</span>
  }
  return <FileIcon size={12} className="tool-trace-row__icon" />
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
    prev.args === next.args &&
    prev.nestedActivities === next.nestedActivities
  )
}

/** run_code 沙箱内嵌套工具活动行 */
function NestedActivityList({
  activities,
  workspaceRoot
}: {
  activities: NestedToolActivity[]
  workspaceRoot?: string | null
}) {
  if (activities.length === 0) return null
  return (
    <div className="tool-trace-row__nested">
      {activities.map(activity => (
        <div key={activity.toolCallId} className="tool-trace-row__nested-row">
          <span className="tool-trace-row__action">{getToolTraceActionChinese(activity.toolName)}</span>
          <span className="tool-trace-row__target">
            {getToolTraceTarget(activity.toolName, activity.args, workspaceRoot)}
          </span>
        </div>
      ))}
    </div>
  )
}

export const ToolTraceRow: React.FC<ToolTraceRowProps> = React.memo(function ToolTraceRow({
  toolCallId,
  name,
  args: argsProp,
  argumentsRaw,
  status,
  result,
  isLiveStreaming = false,
  nestedActivities
}) {
  const [isOpen, setIsOpen] = useState(false)
  const headerRef = useRef<HTMLButtonElement>(null)

  const args = useMemo<Record<string, unknown>>(() => {
    if (argumentsRaw !== undefined) {
      return parsePartialToolArgs(name, argumentsRaw)
    }
    return argsProp ?? {}
  }, [name, argumentsRaw, argsProp])

  const workspaceRoot = useWorkspaceStore(state => state.currentProjectPath)
  const actionText = getToolTraceActionChinese(name)

  const anchoredRequest = useAgentStore(state =>
    selectAnchoredRequest(state.pendingPermissionRequest, toolCallId)
  )

  const isFileTool =
    name === 'read' ||
    name === 'write' ||
    name === 'edit' ||
    name === 'save_plan'

  const rawPath = (args.path as string) || (args.filePath as string) || ''
  const isLs = name === 'ls'
  const isBash = name === 'bash'

  const fileParts = isFileTool || isLs ? splitFilePath(rawPath || (isLs ? '.' : ''), workspaceRoot) : null
  const command = isBash ? (args.command as string) || '' : ''
  const generalTarget = !isFileTool && !isLs && !isBash ? getToolTraceTarget(name, args, workspaceRoot) : ''

  const fullTitle = isFileTool
    ? `${actionText} ${fileParts?.dir || ''}${fileParts?.filename || ''}`
    : isBash
      ? `${actionText} ${command}`
      : `${actionText} ${generalTarget || fileParts?.filename || ''}`

  const rootClass = [
    'tool-trace-row',
    isLiveStreaming ? 'tool-trace-row--live' : '',
    status === 'error' ? 'tool-trace-row--error' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const handleOpenFile = (e: React.MouseEvent) => {
    e.stopPropagation()
    const relPath = rawPath ? compactPathForTrace(rawPath, workspaceRoot) : ''
    if (!relPath) return
    useLayoutStore.getState().openFiles()
    useFileTreeStore.getState().selectFile(relPath)
  }

  const handleOpenDir = (e: React.MouseEvent) => {
    e.stopPropagation()
    const relPath = rawPath && rawPath !== '.' ? compactPathForTrace(rawPath, workspaceRoot) : ''
    useLayoutStore.getState().openFiles()
    useFileTreeStore.getState().selectFile(null)
    if (relPath) {
      useFileTreeStore.getState().setExpanded(relPath, true)
    }
  }

  return (
    <div className={rootClass}>
      <button
        ref={headerRef}
        type="button"
        className="tool-trace-row__header"
        onClick={() => setIsOpen(prev => !prev)}
        aria-expanded={isOpen}
        title={fullTitle}
      >
        <span className="tool-trace-row__action">{actionText}</span>
        <TraceFileBadgeOrIcon toolName={name} ext={fileParts?.ext || ''} />

        {isFileTool && (
          <span
            className="tool-trace-row__file-target"
            onClick={handleOpenFile}
            title={`在侧边栏查看 ${fileParts?.filename || rawPath}`}
          >
            <span className="tool-trace-row__filename">{fileParts?.filename || 'file'}</span>
            {fileParts?.dir ? <span className="tool-trace-row__dirname">{fileParts.dir}</span> : null}
          </span>
        )}

        {isLs && (
          <span
            className="tool-trace-row__file-target"
            onClick={handleOpenDir}
            title={`在侧边栏查看目录 ${fileParts?.filename || fileParts?.dir || '.'}`}
          >
            <span className="tool-trace-row__filename">{fileParts?.filename || fileParts?.dir || '.'}</span>
            {fileParts?.dir && fileParts?.filename ? (
              <span className="tool-trace-row__dirname">{fileParts.dir}</span>
            ) : null}
          </span>
        )}

        {isBash && (
          <span className="tool-trace-row__command" title={command}>
            {command}
          </span>
        )}

        {!isFileTool && !isLs && !isBash && (
          <span className="tool-trace-row__text">{generalTarget}</span>
        )}

        <ChevronIcon
          size={12}
          direction={isOpen ? 'down' : 'right'}
          className="tool-trace-row__chevron"
        />
      </button>

      <TurnProcessCollapsible
        open={isOpen}
        className="tool-trace-row__collapsible"
        pinHeaderRef={headerRef}
      >
        <ToolTraceDetail name={name} args={args} status={status} result={result} />
      </TurnProcessCollapsible>

      {nestedActivities && nestedActivities.length > 0 && (
        <NestedActivityList activities={nestedActivities} workspaceRoot={workspaceRoot} />
      )}

      {anchoredRequest && (
        <div className="tool-trace-row__permission">
          <InlinePermissionBar request={anchoredRequest} />
        </div>
      )}
    </div>
  )
}, areTracePropsEqual)
