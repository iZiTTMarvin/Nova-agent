/**
 * ToolCallGroup — 相邻同族过程工具的中文摘要行
 *
 * 默认折叠收起；对齐 Cursor 视觉风格（紧凑中文摘要头 + 展开平铺时间线与文件类型徽标）。
 */
import React, { useRef, useState } from 'react'
import {
  ChevronIcon,
  SearchIcon,
  EditIcon,
  TerminalIcon,
  FileIcon,
  FolderIcon
} from '../../components/Icons'
import { TurnProcessCollapsible } from './TurnProcessCollapsible'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useFileTreeStore } from '../inspector/useFileTreeStore'
import {
  compactPathForTrace,
  getToolGroupHeaderInfo,
  getToolTraceActionChinese,
  getToolTraceTarget,
  splitFilePath,
  type ToolGroupKind
} from './toolTraceDisplay'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import type { RendererToolBlock } from '../../stores/types'
import './ToolCallGroup.css'

export interface ToolCallGroupProps {
  toolName: string
  blocks: RendererToolBlock[]
}

function GroupHeaderIcon({
  kind,
  status
}: {
  kind: ToolGroupKind | null
  status: RendererToolBlock['status']
}) {
  const isRunning = status === 'running'
  const isError = status === 'error'
  const iconClass = [
    'tool-call-group__icon',
    isRunning ? 'tool-call-group__icon--running' : '',
    isError ? 'tool-call-group__icon--error' : ''
  ]
    .filter(Boolean)
    .join(' ')

  if (kind === 'explore') {
    return <SearchIcon size={14} className={iconClass} />
  }
  if (kind === 'write') {
    return <EditIcon size={14} className={iconClass} />
  }
  if (kind === 'command') {
    return <TerminalIcon size={14} className={iconClass} />
  }
  return (
    <span
      className={`tool-call-group__status-dot tool-call-group__status-dot--${status}`}
      aria-hidden="true"
    />
  )
}

function FileBadgeOrIcon({
  toolName,
  ext
}: {
  toolName: string
  ext: string
}) {
  if (toolName === 'ls') {
    return <FolderIcon size={12} className="tool-call-group__item-icon tool-call-group__item-icon--folder" />
  }
  if (toolName === 'grep' || toolName === 'find' || toolName === 'web_search') {
    return <SearchIcon size={12} className="tool-call-group__item-icon" />
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
  return <FileIcon size={12} className="tool-call-group__item-icon" />
}

export const ToolCallGroup: React.FC<ToolCallGroupProps> = React.memo(function ToolCallGroup({
  toolName,
  blocks
}) {
  const [isOpen, setIsOpen] = useState(false)
  const headerRef = useRef<HTMLButtonElement>(null)
  const workspaceRoot = useWorkspaceStore(state => state.currentProjectPath)
  const headerInfo = getToolGroupHeaderInfo(blocks, toolName)
  const status = aggregateStatus(blocks)

  const title = headerInfo?.title ?? '过程'
  const summaryText = headerInfo?.summaryText ?? `${blocks.length} 项`
  const fullSummary = headerInfo?.fullSummary ?? `${title} · ${summaryText}`

  return (
    <div className="tool-call-group">
      <button
        ref={headerRef}
        type="button"
        className="tool-call-group__header"
        onClick={() => setIsOpen(prev => !prev)}
        aria-expanded={isOpen}
        title={fullSummary}
      >
        <span className="tool-call-group__icon-slot">
          <GroupHeaderIcon kind={headerInfo?.kind ?? null} status={status} />
        </span>
        <span className="tool-call-group__title">{title}</span>
        <span className="tool-call-group__sep" aria-hidden="true">·</span>
        <span className="tool-call-group__summary-text">{summaryText}</span>
        <ChevronIcon
          size={12}
          direction={isOpen ? 'down' : 'right'}
          className="tool-call-group__chevron"
        />
      </button>

      <TurnProcessCollapsible
        open={isOpen}
        className="tool-call-group__expandable"
        pinHeaderRef={headerRef}
      >
        <ul className="tool-call-group__list">
          {blocks.map(block => {
            const actionText = getToolTraceActionChinese(block.toolName)
            const args = block.arguments ?? {}
            const isFileTool =
              block.toolName === 'read' ||
              block.toolName === 'write' ||
              block.toolName === 'edit' ||
              block.toolName === 'save_plan'

            if (isFileTool) {
              const rawPath = (args.path as string) || (args.filePath as string) || ''
              const { filename, dir, ext } = splitFilePath(rawPath, workspaceRoot)
              const relPath = rawPath ? compactPathForTrace(rawPath, workspaceRoot) : ''
              const handleOpenFile = (e: React.MouseEvent) => {
                e.stopPropagation()
                if (!relPath) return
                useLayoutStore.getState().openFiles()
                useFileTreeStore.getState().selectFile(relPath)
              }

              return (
                <li
                  key={block.toolCallId}
                  className="tool-call-group__item tool-call-group__item--clickable"
                  onClick={handleOpenFile}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handleOpenFile(e as unknown as React.MouseEvent)
                    }
                  }}
                  title={`在侧边栏查看 ${filename || relPath}`}
                >
                  <span className="tool-call-group__item-action">{actionText}</span>
                  <FileBadgeOrIcon toolName={block.toolName} ext={ext} />
                  <span className="tool-call-group__item-filename">{filename || 'file'}</span>
                  {dir ? <span className="tool-call-group__item-dirname">{dir}</span> : null}
                </li>
              )
            }

            if (block.toolName === 'ls') {
              const rawPath = (args.path as string) || '.'
              const { filename, dir } = splitFilePath(rawPath, workspaceRoot)
              const displayTarget = filename || dir || '.'
              const relPath = rawPath && rawPath !== '.' ? compactPathForTrace(rawPath, workspaceRoot) : ''
              const handleOpenDir = (e: React.MouseEvent) => {
                e.stopPropagation()
                useLayoutStore.getState().openFiles()
                useFileTreeStore.getState().selectFile(null)
                if (relPath) {
                  useFileTreeStore.getState().setExpanded(relPath, true)
                }
              }

              return (
                <li
                  key={block.toolCallId}
                  className="tool-call-group__item tool-call-group__item--clickable"
                  onClick={handleOpenDir}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handleOpenDir(e as unknown as React.MouseEvent)
                    }
                  }}
                  title={`在侧边栏查看目录 ${displayTarget}`}
                >
                  <span className="tool-call-group__item-action">{actionText}</span>
                  <FileBadgeOrIcon toolName={block.toolName} ext="" />
                  <span className="tool-call-group__item-filename">{displayTarget}</span>
                  {dir && filename ? <span className="tool-call-group__item-dirname">{dir}</span> : null}
                </li>
              )
            }

            if (block.toolName === 'bash') {
              const cmd = (args.command as string) || ''
              return (
                <li key={block.toolCallId} className="tool-call-group__item">
                  <span className="tool-call-group__item-action">{actionText}</span>
                  <span className="tool-call-group__item-command" title={cmd}>
                    {cmd}
                  </span>
                </li>
              )
            }

            const targetText = getToolTraceTarget(block.toolName, args, workspaceRoot)
            return (
              <li key={block.toolCallId} className="tool-call-group__item">
                <span className="tool-call-group__item-action">{actionText}</span>
                <FileBadgeOrIcon toolName={block.toolName} ext="" />
                <span className="tool-call-group__item-text">{targetText}</span>
              </li>
            )
          })}
        </ul>
      </TurnProcessCollapsible>
    </div>
  )
})

function aggregateStatus(blocks: RendererToolBlock[]): RendererToolBlock['status'] {
  if (blocks.some(b => b.status === 'running')) return 'running'
  if (blocks.some(b => b.status === 'error')) return 'error'
  return 'success'
}
