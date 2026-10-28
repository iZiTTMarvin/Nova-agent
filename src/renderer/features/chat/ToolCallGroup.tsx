/**
 * ToolCallGroup — 相邻同族过程工具的摘要行
 *
 * 组头：动作、数量与真实存在的状态；展开后每项保留自己的状态与详情。
 * 文件与目录项保持“点击在右侧打开”的入口；其余项复用 ToolTraceRow 的参数/结果/错误详情。
 * 授权入口固定画在组头下方，组折叠时依然可见、只出现一次。
 */
import React, { useCallback, useRef, useState } from 'react'
import {
  ChevronIcon,
  SearchIcon,
  EditIcon,
  TerminalIcon,
  FileIcon,
  FolderIcon,
  GlobeIcon
} from '../../components/Icons'
import { TurnProcessCollapsible } from './TurnProcessCollapsible'
import { ToolTraceRow, selectAnchoredRequest } from './ToolTraceRow'
import { InlinePermissionBar } from '../permissions/InlinePermissionBar'
import { useAgentStore } from '../../stores/useAgentStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useFileTreeStore } from '../inspector/useFileTreeStore'
import {
  compactPathForTrace,
  getToolGroupHeaderInfo,
  getToolTraceActionChinese,
  splitFilePath,
  type ToolGroupKind
} from './toolTraceDisplay'
import {
  AWAITING_PERMISSION_LABEL,
  countToolOutcomes,
  formatToolOutcomeCounts,
  getToolOutcomeLabel,
  resolveToolOutcome,
  type ToolOutcomeCounts
} from './toolOutcome'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import type { RendererToolBlock } from '../../stores/types'
import './ToolCallGroup.css'

export interface ToolCallGroupProps {
  toolName: string
  blocks: RendererToolBlock[]
  /** 稳定的组身份（首个调用的 toolCallId），新调用加入时不变 */
  groupId: string
  /** 展开状态按 key 保存在上层：组用 `group:${groupId}`，单项用 toolCallId；不传则组件自己保存 */
  traceOpen?: Readonly<Record<string, boolean>>
  onTraceOpenChange?: (key: string, open: boolean) => void
}

export function groupOpenKey(groupId: string): string {
  return `group:${groupId}`
}

function GroupHeaderIcon({
  kind,
  counts
}: {
  kind: ToolGroupKind | null
  counts: ToolOutcomeCounts
}) {
  const iconClass = [
    'tool-call-group__icon',
    counts.running > 0 ? 'tool-call-group__icon--running' : '',
    counts.failed > 0 ? 'tool-call-group__icon--error' : ''
  ]
    .filter(Boolean)
    .join(' ')

  if (kind === 'web') return <GlobeIcon size={14} className={iconClass} />
  if (kind === 'explore') return <SearchIcon size={14} className={iconClass} />
  if (kind === 'write') return <EditIcon size={14} className={iconClass} />
  if (kind === 'command') return <TerminalIcon size={14} className={iconClass} />
  return <span className="tool-call-group__status-dot" aria-hidden="true" />
}

function FileBadgeOrIcon({ toolName, ext }: { toolName: string; ext: string }) {
  if (toolName === 'ls') {
    return <FolderIcon size={12} className="tool-call-group__item-icon tool-call-group__item-icon--folder" />
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

const FILE_TOOL_NAMES = new Set(['read', 'write', 'edit', 'save_plan'])

/** 点击即在右侧打开文件/目录的轻量项；失败或未完成时改用可展开行，让原因可见。 */
function FileOrDirItem({
  block,
  workspaceRoot
}: {
  block: RendererToolBlock
  workspaceRoot: string | null
}) {
  const args = block.arguments ?? {}
  const actionText = getToolTraceActionChinese(block.toolName)
  const outcome = resolveToolOutcome(block)
  const statusLabel = getToolOutcomeLabel(block.toolName, outcome)
  const status = statusLabel ? (
    <span className={`tool-call-group__item-status tool-call-group__item-status--${outcome}`}>
      {statusLabel}
    </span>
  ) : null

  if (block.toolName === 'ls') {
    const rawPath = (args.path as string) || '.'
    const { filename, dir } = splitFilePath(rawPath, workspaceRoot)
    const displayTarget = filename || dir || '.'
    const relPath = rawPath && rawPath !== '.' ? compactPathForTrace(rawPath, workspaceRoot) : ''
    const openDir = (): void => {
      useLayoutStore.getState().openFiles()
      useFileTreeStore.getState().selectFile(null)
      if (relPath) {
        useFileTreeStore.getState().setExpanded(relPath, true)
      }
    }
    return (
      <div
        className="tool-call-group__item tool-call-group__item--clickable"
        onClick={openDir}
        role="button"
        tabIndex={0}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openDir()
          }
        }}
        title={`在侧边栏查看目录 ${displayTarget}`}
      >
        <span className="tool-call-group__item-action">{actionText}</span>
        <FileBadgeOrIcon toolName="ls" ext="" />
        <span className="tool-call-group__item-filename">{displayTarget}</span>
        {dir && filename ? <span className="tool-call-group__item-dirname">{dir}</span> : null}
        {status}
      </div>
    )
  }

  const rawPath = (args.path as string) || (args.filePath as string) || ''
  const { filename, dir, ext } = splitFilePath(rawPath, workspaceRoot)
  const relPath = rawPath ? compactPathForTrace(rawPath, workspaceRoot) : ''
  const openFile = (): void => {
    if (!relPath) return
    useLayoutStore.getState().openFiles()
    useFileTreeStore.getState().selectFile(relPath)
  }
  return (
    <div
      className="tool-call-group__item tool-call-group__item--clickable"
      onClick={openFile}
      role="button"
      tabIndex={0}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openFile()
        }
      }}
      title={`在侧边栏查看 ${filename || relPath}`}
    >
      <span className="tool-call-group__item-action">{actionText}</span>
      <FileBadgeOrIcon toolName={block.toolName} ext={ext} />
      <span className="tool-call-group__item-filename">{filename || 'file'}</span>
      {dir ? <span className="tool-call-group__item-dirname">{dir}</span> : null}
      {status}
    </div>
  )
}

export const ToolCallGroup: React.FC<ToolCallGroupProps> = React.memo(function ToolCallGroup({
  toolName,
  blocks,
  groupId,
  traceOpen: controlledTraceOpen,
  onTraceOpenChange: controlledOnTraceOpenChange
}) {
  const headerRef = useRef<HTMLButtonElement>(null)
  const [localTraceOpen, setLocalTraceOpen] = useState<Readonly<Record<string, boolean>>>({})
  const traceOpen = controlledTraceOpen ?? localTraceOpen
  const onTraceOpenChange = useCallback(
    (key: string, open: boolean) => {
      if (controlledOnTraceOpenChange) controlledOnTraceOpenChange(key, open)
      else setLocalTraceOpen(previous => ({ ...previous, [key]: open }))
    },
    [controlledOnTraceOpenChange]
  )
  const workspaceRoot = useWorkspaceStore(state => state.currentProjectPath)
  const headerInfo = getToolGroupHeaderInfo(blocks, toolName)
  const counts = countToolOutcomes(blocks)

  // 授权请求只锚定到 toolCallIds 的最后一项；组负责渲染它，行内不再重复
  const anchoredRequest = useAgentStore(state => {
    const request = state.pendingPermissionRequest
    if (!request) return null
    return blocks.some(block => selectAnchoredRequest(request, block.toolCallId) !== null)
      ? request
      : null
  })

  const openKey = groupOpenKey(groupId)
  // 单条调用变成分组时，已展开的那一项让组默认保持展开
  const isOpen = traceOpen[openKey] ?? blocks.some(block => traceOpen[block.toolCallId] === true)

  const title = headerInfo?.title ?? '过程'
  const summaryText = headerInfo?.summaryText ?? `${blocks.length} 项`
  const fullSummary = headerInfo?.fullSummary ?? `${title} ${summaryText}`
  const statusParts = formatToolOutcomeCounts(counts)
  if (anchoredRequest) statusParts.push(AWAITING_PERMISSION_LABEL)
  const hasProblem = counts.failed > 0 || counts.incomplete > 0

  return (
    <div className="tool-call-group" data-group-id={groupId}>
      <button
        ref={headerRef}
        type="button"
        className="tool-call-group__header"
        onClick={() => onTraceOpenChange(openKey, !isOpen)}
        aria-expanded={isOpen}
        title={fullSummary}
      >
        <span className="tool-call-group__icon-slot">
          <GroupHeaderIcon kind={headerInfo?.kind ?? null} counts={counts} />
        </span>
        <span className="tool-call-group__title">{title}</span>
        <span className="tool-call-group__summary-text">{summaryText}</span>
        {statusParts.length > 0 && (
          <span
            className={`tool-call-group__outcome${hasProblem ? ' tool-call-group__outcome--problem' : ''}`}
          >
            {statusParts.join(' ')}
          </span>
        )}
        <ChevronIcon
          size={12}
          direction={isOpen ? 'down' : 'right'}
          className="tool-call-group__chevron"
        />
      </button>

      {anchoredRequest && (
        <div className="tool-call-group__permission">
          <InlinePermissionBar request={anchoredRequest} />
        </div>
      )}

      <TurnProcessCollapsible
        open={isOpen}
        className="tool-call-group__expandable"
        pinHeaderRef={headerRef}
      >
        <ul className="tool-call-group__list">
          {blocks.map(block => {
            const outcome = resolveToolOutcome(block)
            const isFileOrDir = FILE_TOOL_NAMES.has(block.toolName) || block.toolName === 'ls'
            const showLightItem = isFileOrDir && (outcome === 'running' || outcome === 'success')
            return (
              <li key={block.toolCallId} className="tool-call-group__item-wrap">
                {showLightItem ? (
                  <FileOrDirItem block={block} workspaceRoot={workspaceRoot} />
                ) : (
                  <ToolTraceRow
                    toolCallId={block.toolCallId}
                    name={block.toolName}
                    args={block.arguments}
                    status={block.status}
                    result={block.result}
                    open={traceOpen[block.toolCallId] ?? false}
                    onOpenChange={onTraceOpenChange}
                    embedded
                    permissionHandledByGroup
                  />
                )}
              </li>
            )
          })}
        </ul>
      </TurnProcessCollapsible>
    </div>
  )
})
