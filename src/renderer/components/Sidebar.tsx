import React, { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useChatStore } from '../stores/useChatStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useLayoutStore, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX } from '../stores/useLayoutStore'
import type { PrimarySession, Session } from '../../shared/session/types'
import {
  SESSION_PLACEHOLDER_TITLE,
  SESSION_TITLE_MAX_LENGTH,
  clampSessionTitle
} from '../../shared/session/title'
import {
  NovaLogo,
  FolderIcon,
  SettingsIcon,
  PlusIcon,
  PinIcon,
  PanelLeftIcon,
  SearchIcon,
  ChevronDownIcon,
  FilterIcon,
  TerminalIcon
} from './Icons'
import { Button } from '@astryxdesign/core/Button'
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu'
import { IconButton } from '@astryxdesign/core/IconButton'
import { TextInput } from '@astryxdesign/core/TextInput'
import { SideNav, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { useRunStore } from '../stores/useRunStore'
import { useAgentStore } from '../stores/useAgentStore'
import { selectCurrentCodeIndexStatus, useCodeIndexStore } from '../stores/useCodeIndexStore'
import {
  listPinnedSessions,
  listSidebarRootSessions,
  resolveSidebarActiveSessionId
} from '../features/subagents/sidebarSessions'
import type { AppUpdateSnapshot } from '../../shared/update'
import { UpdateIndicator } from '../features/update/UpdateIndicator'
import { formatCompactRelativeTime } from '../lib/time'
import './Sidebar.css'

/** 每个项目下默认展示的最新会话数 */
const SIDEBAR_SESSION_PREVIEW_COUNT = 5
const EXPANDED_PROJECTS_KEY = 'nova.sidebar.expandedProjects'
const PINNED_PROJECTS_KEY = 'nova.sidebar.pinnedProjects'
const ARCHIVED_PROJECTS_KEY = 'nova.sidebar.archivedProjects'

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

function newSessionShortcutLabel(): string {
  if (typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)) {
    return '⌘N'
  }
  return 'Ctrl+N'
}

function getStoredExpandedProjects(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(EXPANDED_PROJECTS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function setStoredExpandedProjects(val: Record<string, boolean>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(val))
  } catch {
    // 忽略配额错误
  }
}

function getStoredPinnedProjects(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(PINNED_PROJECTS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function setStoredPinnedProjects(val: Record<string, boolean>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify(val))
  } catch {
    // 忽略配额错误
  }
}

function getStoredArchivedProjects(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(ARCHIVED_PROJECTS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function setStoredArchivedProjects(val: Record<string, boolean>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(ARCHIVED_PROJECTS_KEY, JSON.stringify(val))
  } catch {
    // 忽略配额错误
  }
}

/** 侧栏状态色点：自绘制确保冷感呼吸律动，且避免拉裂预构建 React */
function SidebarStatusDot({
  tone,
  label,
  isPulsing = false,
  onActivate
}: {
  tone: 'warning' | 'accent' | 'running'
  label: string
  isPulsing?: boolean
  onActivate?: () => void
}) {
  let color = 'var(--accent-primary, #3b82f6)'
  if (tone === 'warning') color = 'var(--accent-warning, #f59e0b)'
  else if (tone === 'running') color = 'var(--accent-running, #22c55e)'

  const classes = [
    'sidebar-status-dot',
    isPulsing ? 'sidebar-status-dot--pulse' : '',
    onActivate ? 'sidebar-status-dot--interactive' : ''
  ].filter(Boolean).join(' ')

  return (
    <span
      role={onActivate ? 'button' : 'img'}
      aria-label={label}
      title={label}
      className={classes}
      style={{ backgroundColor: color }}
      tabIndex={onActivate ? 0 : undefined}
      onClick={onActivate
        ? (event) => {
            event.stopPropagation()
            onActivate()
          }
        : undefined}
      onKeyDown={onActivate
        ? (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            event.stopPropagation()
            onActivate()
          }
        : undefined}
    />
  )
}

/** 会话导航主体内容 */
interface SidebarSessionsProps {
  updateSnapshot: AppUpdateSnapshot | null
  onFocusSearch?: () => void
  searchTriggerCount?: number
}

const SidebarSessions = React.memo(function SidebarSessions({
  updateSnapshot,
  searchTriggerCount = 0
}: SidebarSessionsProps) {
  const sessions = useChatStore(state => state.sessions)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const createNewSession = useChatStore(state => state.createNewSession)
  const selectSession = useChatStore(state => state.selectSession)
  const deleteSession = useChatStore(state => state.deleteSession)
  const renameSession = useChatStore(state => state.renameSession)
  const setSessionPinned = useChatStore(state => state.setSessionPinned)
  const selectProject = useSettingsStore(state => state.selectProject)
  const currentProject = useSettingsStore(state => state.currentProject)
  const setConfigModalOpen = useSettingsStore(state => state.setConfigModalOpen)
  const openCodeIndexSettings = useSettingsStore(state => state.openCodeIndexSettings)

  const codeIndexSnapshot = useCodeIndexStore(selectCurrentCodeIndexStatus)
  const waitingSessions = useRunStore(state => state.waitingSessions)
  const snapshotsByRunId = useRunStore(state => state.snapshotsByRunId)
  const cancelExecution = useAgentStore(state => state.cancelExecution)

  // 搜索与过滤局部状态
  const [filterText, setFilterText] = useState('')
  const [isFilterOpen, setIsFilterOpen] = useState(false)
  const filterInputRef = useRef<HTMLInputElement>(null)

  // 当外部顶行点击 Search 或快捷键时触发聚焦过滤输入
  useEffect(() => {
    if (searchTriggerCount > 0) {
      setIsFilterOpen(true)
      setTimeout(() => filterInputRef.current?.focus(), 50)
    }
  }, [searchTriggerCount])

  /** 后台运行中会话：非焦点、非终态 run，按 sessionId 去重 */
  const runningSessions = useMemo(() => {
    const activeStatuses = new Set(['running', 'retrying', 'resuming', 'cancelling'])
    const map = new Map<string, { sessionId: string; runId: string }>()
    for (const snap of Object.values(snapshotsByRunId)) {
      if (activeStatuses.has(snap.status) && snap.sessionId !== currentSessionId) {
        map.set(snap.sessionId, { sessionId: snap.sessionId, runId: snap.runId })
      }
    }
    return [...map.values()]
  }, [snapshotsByRunId, currentSessionId])

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [openMenuSessionId, setOpenMenuSessionId] = useState<string | null>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const editCancelledRef = useRef(false)

  const containerRef = useRef<HTMLDivElement>(null)

  const getSidebarRightEdge = (): number => {
    const shell = containerRef.current?.closest('.sidebar-shell')
    if (shell) {
      return shell.getBoundingClientRect().right
    }
    return 260
  }

  const [pinnedProjects, setPinnedProjects] = useState<Record<string, boolean>>(getStoredPinnedProjects)
  const [archivedProjects, setArchivedProjects] = useState<Record<string, boolean>>(getStoredArchivedProjects)
  const [openMenuProjectPath, setOpenMenuProjectPath] = useState<string | null>(null)
  const [isArchivedSectionExpanded, setIsArchivedSectionExpanded] = useState(false)

  const togglePinProject = (path: string) => {
    setPinnedProjects(prev => {
      const next = { ...prev, [path]: !prev[path] }
      setStoredPinnedProjects(next)
      return next
    })
  }

  const toggleArchiveProject = (path: string) => {
    setArchivedProjects(prev => {
      const next = { ...prev, [path]: !prev[path] }
      setStoredArchivedProjects(next)
      return next
    })
  }

  const handleDeleteProject = async (projectPath: string, projectSessions: PrimarySession[]) => {
    const response = await window.api.invoke('dialog:confirm', {
      title: '删除项目',
      message: `确定要删除项目“${getProjectName(projectPath)}”吗？`,
      detail: `这将删除该项目下的所有会话（共 ${projectSessions.length} 个任务），删除后无法恢复。`
    })
    if (response !== 1) return
    try {
      for (const session of projectSessions) {
        await deleteSession(session.id)
      }
    } catch (err) {
      await window.api.invoke('dialog:confirm', {
        type: 'error',
        title: '无法删除项目',
        message: err instanceof Error ? err.message : '删除项目会话失败',
        detail: '请先停止运行中的任务，再重试删除。'
      })
    }
  }

  const handleOpenProjectDirectory = async (path: string) => {
    try {
      await window.api.invoke('workspace:open-directory', { path })
    } catch (err) {
      console.error('打开项目目录失败:', err)
    }
  }

  // 项目树悬停卡片（hover 超过 1s 后弹出）
  const [hoveredProject, setHoveredProject] = useState<{
    path: string
    rect: DOMRect
    sessions: PrimarySession[]
    indexStatus: string | null
  } | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 当项目菜单打开时立即关闭 hover 浮窗
  useEffect(() => {
    if (openMenuProjectPath) {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = null
      }
      setHoveredProject(null)
    }
  }, [openMenuProjectPath])

  const handleProjectMouseEnter = (
    e: React.MouseEvent<HTMLDivElement>,
    path: string,
    projectSessions: PrimarySession[],
    indexStatus: string | null
  ) => {
    if (openMenuProjectPath) return
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    const rect = e.currentTarget.getBoundingClientRect()
    hoverTimerRef.current = setTimeout(() => {
      if (openMenuProjectPath) return
      setHoveredProject({
        path,
        rect,
        sessions: projectSessions,
        indexStatus
      })
    }, 1000) // 超过 1 秒钟才出现信息悬浮窗
  }

  const handleProjectMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    closeTimerRef.current = setTimeout(() => {
      setHoveredProject(null)
    }, 200)
  }

  const handlePopoverMouseEnter = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const handlePopoverMouseLeave = () => {
    setHoveredProject(null)
  }

  // 页面滚动时立即关闭项目悬浮窗，卸载时清理所有定时器
  useEffect(() => {
    const handleScroll = () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = null
      }
      setHoveredProject(null)
    }
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      window.removeEventListener('scroll', handleScroll, true)
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  // Ctrl+N 快捷键监听
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'n') return
      if (isEditableKeyboardTarget(event.target)) return
      event.preventDefault()
      void createNewSession(currentProject || undefined)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [createNewSession, currentProject])

  // Ctrl+P 快捷键监听会话检索
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'p') return
      if (isEditableKeyboardTarget(event.target)) return
      event.preventDefault()
      setIsFilterOpen(true)
      setTimeout(() => filterInputRef.current?.focus(), 50)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const sidebarActiveSessionId = resolveSidebarActiveSessionId(sessions, currentSessionId)

  // 项目分组派生
  const rootSessions = listSidebarRootSessions(sessions)
  const projectGroups = useMemo(() => {
    return rootSessions.reduce((acc, session) => {
      const p = session.workspaceRoot
      if (!acc[p]) acc[p] = []
      acc[p].push(session)
      return acc
    }, {} as Record<string, ReturnType<typeof listSidebarRootSessions>>)
  }, [rootSessions])

  // 项目分组与排序（分离归档与置顶排序）
  const { activeProjectEntries, archivedProjectEntries } = useMemo(() => {
    const entries = Object.entries(projectGroups)
    const active: [string, PrimarySession[]][] = []
    const archived: [string, PrimarySession[]][] = []

    for (const entry of entries) {
      if (archivedProjects[entry[0]]) {
        archived.push(entry)
      } else {
        active.push(entry)
      }
    }

    // 活跃项目中，置顶项目排在最前
    active.sort(([pathA], [pathB]) => {
      const pinnedA = pinnedProjects[pathA] ? 1 : 0
      const pinnedB = pinnedProjects[pathB] ? 1 : 0
      return pinnedB - pinnedA
    })

    return { activeProjectEntries: active, archivedProjectEntries: archived }
  }, [projectGroups, pinnedProjects, archivedProjects])

  // 项目展开持久化状态：渲染对缺省键视为展开，故初始化只需还原持久化记录，
  // 不必等会话加载完补齐键（会话异步到达前项目表为空，补键会丢持久化值）
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(() => getStoredExpandedProjects())

  // 同步新项目并写入缓存
  const toggleProjectExpand = (projectPath: string) => {
    setExpandedProjects(prev => {
      // 与渲染口径一致：缺省视为展开，取反即「当前是否折叠」
      const next = { ...prev, [projectPath]: prev[projectPath] === false }
      setStoredExpandedProjects(next)
      return next
    })
  }

  /** 每个项目会话列表是否已点「显示更多」 */
  const [expandedSessionLists, setExpandedSessionLists] = useState<Record<string, boolean>>({})

  const getProjectName = (pathStr: string) => {
    const parts = pathStr.split(/[\\/]/)
    return parts[parts.length - 1] || pathStr
  }

  const getDisplayTitle = (session: Session) => {
    return session.title || SESSION_PLACEHOLDER_TITLE
  }

  const formatDetailTitleTime = (ts: number) => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  const handleDelete = async (sessionId: string) => {
    const response = await window.api.invoke('dialog:confirm', {
      title: '删除会话',
      message: '确定要删除这个会话吗？',
      detail: '删除后无法恢复。'
    })
    if (response !== 1) return
    try {
      await deleteSession(sessionId)
    } catch (err) {
      await window.api.invoke('dialog:confirm', {
        type: 'error',
        title: '无法删除会话',
        message: err instanceof Error ? err.message : '删除会话失败',
        detail: '请先停止该会话的任务，再重试删除。',
        buttons: ['确定'],
        defaultId: 0,
        cancelId: 0
      })
    }
  }

  const startEditing = (session: Session) => {
    editCancelledRef.current = false
    setEditingId(session.id)
    setEditValue(getDisplayTitle(session))
  }

  const cancelEditing = () => {
    setEditingId(null)
    setEditValue('')
  }

  const submitRename = async (sessionId: string) => {
    if (editCancelledRef.current) {
      editCancelledRef.current = false
      return
    }
    const session = sessions.find(s => s.id === sessionId)
    const trimmed = editValue.trim()
    if (!session || !trimmed) {
      cancelEditing()
      return
    }
    const finalTitle = clampSessionTitle(trimmed)
    if (finalTitle !== getDisplayTitle(session)) {
      await renameSession(sessionId, finalTitle)
    }
    cancelEditing()
  }

  const handleEditKeyDown = (e: React.KeyboardEvent, sessionId: string) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      void submitRename(sessionId)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      editCancelledRef.current = true
      cancelEditing()
    }
  }

  const pinnedSessions = listPinnedSessions(sessions)

  const togglePin = (session: PrimarySession) => {
    setOpenMenuSessionId(null)
    void setSessionPinned(session.id, !session.pinned)
  }

  // 过滤处理逻辑
  const normalizedFilter = filterText.trim().toLowerCase()
  const filterSessionMatch = (session: PrimarySession) => {
    if (!normalizedFilter) return true
    return getDisplayTitle(session).toLowerCase().includes(normalizedFilter)
  }

  /** 单条高密度会话行（ThreadItem） */
  const renderSessionRow = (session: PrimarySession, leadingIcon?: React.ReactNode) => {
    const isActive = session.id === sidebarActiveSessionId
    const isEditing = editingId === session.id
    const displayTitle = getDisplayTitle(session)
    const waitingBadge = waitingSessions.find(w => w.sessionId === session.id)
    const showWaiting = !!waitingBadge && !isActive
    const runningBadge = runningSessions.find(r => r.sessionId === session.id)
    const showRunning = !!runningBadge && !isActive
    const detailTitle = `${displayTitle}\n${formatDetailTitleTime(session.updatedAt)}${session.messageCount > 0 ? ` · ${session.messageCount} 条对话` : ''}`
    const compactTime = formatCompactRelativeTime(session.updatedAt)

    return (
      <div
        key={session.id}
        className={[
          'sidebar-session-row',
          isActive ? 'sidebar-session-row--active' : '',
          openMenuSessionId === session.id ? 'sidebar-session-row--menu-open' : ''
        ].filter(Boolean).join(' ')}
        title={showWaiting ? '等待你处理' : detailTitle}
      >
        {isEditing ? (
          <TextInput
            ref={editInputRef}
            label="重命名会话"
            isLabelHidden
            size="sm"
            width="100%"
            className="flex-1 min-w-0 text-sm px-1 py-0.5 rounded border border-border-subtle text-text-primary bg-surface-canvas outline-none focus:border-accent-primary"
            value={editValue}
            onChange={(value) => setEditValue(value.slice(0, SESSION_TITLE_MAX_LENGTH))}
            onKeyDown={(e) => handleEditKeyDown(e, session.id)}
            onBlur={() => void submitRename(session.id)}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <SideNavItem
            label={displayTitle}
            icon={leadingIcon}
            size="sm"
            isSelected={isActive}
            onClick={() => {
              void selectSession(session.id)
            }}
            endContent={(
              <div className="sidebar-session-row__end-cluster flex items-center shrink-0">
                {showWaiting ? (
                  <SidebarStatusDot tone="warning" label="等待你处理" isPulsing />
                ) : showRunning ? (
                  <SidebarStatusDot tone="running" label="运行中" isPulsing />
                ) : (
                  <span className="sidebar-session-row__meta text-xs text-text-muted tabular-nums shrink-0">
                    {compactTime}
                  </span>
                )}
              </div>
            )}
          />
        )}
        {!isEditing && (
          <div className="sidebar-session-row__actions">
            <DropdownMenu
              isMenuOpen={openMenuSessionId === session.id}
              onOpenChange={(open) => setOpenMenuSessionId(open ? session.id : null)}
              button={{
                label: '会话操作',
                icon: <span className="sidebar-session-menu__ellipsis" aria-hidden>⋯</span>,
                variant: 'ghost',
                size: 'sm',
                isIconOnly: true,
                tooltip: '会话操作'
              }}
            >
              {showWaiting || showRunning ? (
                <DropdownMenuItem
                  label="停止运行"
                  onClick={() => {
                    setOpenMenuSessionId(null)
                    void cancelExecution(
                      showWaiting ? waitingBadge?.runId : runningBadge?.runId
                    )
                  }}
                />
              ) : (
                <>
                  <DropdownMenuItem
                    label={session.pinned ? '取消置顶' : '置顶'}
                    onClick={() => togglePin(session)}
                  />
                  <DropdownMenuItem
                    label="重命名"
                    onClick={() => {
                      setOpenMenuSessionId(null)
                      startEditing(session)
                    }}
                  />
                  <DropdownMenuItem
                    label="删除"
                    style={{ color: 'var(--color-error)' }}
                    onClick={() => {
                      setOpenMenuSessionId(null)
                      void handleDelete(session.id)
                    }}
                  />
                </>
              )}
            </DropdownMenu>
          </div>
        )}
      </div>
    )
  }

  const visiblePinnedSessions = pinnedSessions.filter(filterSessionMatch)

  return (
    <div ref={containerRef} className="relative w-full h-full flex flex-col">
      <SideNav
        className="bg-[var(--surface-sidebar)] select-none sidebar-astryx-nav"
        style={{ width: '100%' }}
        topContent={(
          <div className="sidebar-top-actions flex flex-col gap-0.5 w-full px-2 pt-2">
            {/* 1. 主动作按钮：新会话（默认透明无边框，hover 才有轻微背景） */}
            <button
              type="button"
              className="sidebar-action-btn w-full h-[34px] flex items-center justify-between px-3 rounded text-[13px] font-medium text-text-secondary hover:text-text-primary transition-colors"
              onClick={() => createNewSession(currentProject || undefined)}
            >
              <div className="flex items-center gap-2">
                <PlusIcon size={15} />
                <span>新会话</span>
              </div>
              <span className="text-xs font-normal text-text-muted tabular-nums">
                {newSessionShortcutLabel()}
              </span>
            </button>

            {/* 2. 添加工作区（默认透明无边框，hover 才有轻微背景） */}
            <button
              type="button"
              className="sidebar-action-btn w-full h-[34px] flex items-center gap-2 px-3 rounded text-[13px] font-medium text-text-secondary hover:text-text-primary transition-colors"
              onClick={selectProject}
            >
              <FolderIcon size={15} />
              <span>添加工作区</span>
            </button>

            {/* 3. 过滤输入框（仅在展开时显示，平时隐藏） */}
            {isFilterOpen && (
              <div className="sidebar-filter-box pt-1">
                <input
                  ref={filterInputRef}
                  type="text"
                  className="w-full px-2.5 py-1 text-xs rounded border border-border-subtle bg-surface-canvas text-text-primary placeholder:text-text-placeholder outline-none focus:border-accent-primary"
                  placeholder="过滤当前会话..."
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setIsFilterOpen(false)
                      setFilterText('')
                    }
                  }}
                />
              </div>
            )}
          </div>
        )}
        footer={(
          <div className="sidebar-footer-actions flex items-center justify-between w-full px-2 py-1">
            <UpdateIndicator snapshot={updateSnapshot} />
            <IconButton
              label="设置"
              icon={<SettingsIcon size={16} />}
              variant="ghost"
              size="sm"
              tooltip="设置"
              onClick={() => setConfigModalOpen(true)}
            />
          </div>
        )}
      >
        {/* 置顶分区 */}
        {visiblePinnedSessions.length > 0 && (
          <SideNavSection title="置顶">
            {visiblePinnedSessions.map((session) => renderSessionRow(session, <PinIcon size={14} />))}
          </SideNavSection>
        )}

        {/* 项目树分区 */}
        <SideNavSection
          title="项目"
          endContent={(
            <IconButton
              label="过滤会话"
              icon={<FilterIcon size={13} />}
              variant="ghost"
              size="sm"
              tooltip="过滤会话"
              onClick={() => {
                setIsFilterOpen(prev => {
                  const next = !prev
                  if (next) {
                    setTimeout(() => filterInputRef.current?.focus(), 50)
                  }
                  return next
                })
              }}
            />
          )}
        >
          {activeProjectEntries.map(([projectPath, projectSessions]) => {
            const filteredProjectSessions = projectSessions.filter(filterSessionMatch)
            if (filteredProjectSessions.length === 0 && normalizedFilter) return null

            const isExpanded = expandedProjects[projectPath] !== false
            const selectedIndex = filteredProjectSessions.findIndex(session => session.id === sidebarActiveSessionId)
            const selectedBeyondPreview = selectedIndex >= SIDEBAR_SESSION_PREVIEW_COUNT
            const userExpandedSessions = expandedSessionLists[projectPath] === true
            const isSessionListExpanded = userExpandedSessions || selectedBeyondPreview
            const visibleSessions =
              isSessionListExpanded || filteredProjectSessions.length <= SIDEBAR_SESSION_PREVIEW_COUNT
                ? filteredProjectSessions
                : filteredProjectSessions.slice(0, SIDEBAR_SESSION_PREVIEW_COUNT)
            const showMoreToggle = filteredProjectSessions.length > SIDEBAR_SESSION_PREVIEW_COUNT
            const isPinned = pinnedProjects[projectPath] === true
            const isMenuOpen = openMenuProjectPath === projectPath
            const projectIndexStatus = codeIndexSnapshot?.enabled === true &&
              codeIndexSnapshot.workspaceRoot === projectPath &&
              (codeIndexSnapshot.status === 'building' ||
                codeIndexSnapshot.status === 'degraded' ||
                codeIndexSnapshot.status === 'unavailable')
                ? codeIndexSnapshot.status
                : null

            return (
              <div key={projectPath} className="sidebar-project-group mb-0.5">
                {/* 项目标题行：加粗字体，hover 显示操作（三个点与新建会话按钮） */}
                <div
                  className={`sidebar-project-header flex items-center justify-between px-2 py-1 rounded cursor-pointer hover:bg-surface-hover group transition-colors select-none ${
                    isMenuOpen ? 'sidebar-project-header--menu-open' : ''
                  }`}
                  onClick={() => toggleProjectExpand(projectPath)}
                  onMouseEnter={(e) =>
                    handleProjectMouseEnter(
                      e,
                      projectPath,
                      filteredProjectSessions,
                      projectIndexStatus
                    )
                  }
                  onMouseLeave={handleProjectMouseLeave}
                >
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span
                      className={`text-text-muted transition-transform duration-150 inline-block shrink-0 ${
                        isExpanded ? 'rotate-0' : '-rotate-90'
                      }`}
                    >
                      <ChevronDownIcon size={13} />
                    </span>
                    <span className="text-[13px] font-semibold text-text-primary truncate">
                      {getProjectName(projectPath)}
                    </span>
                    {isPinned && (
                      <span title="已置顶" className="shrink-0 text-text-muted inline-flex">
                        <PinIcon size={11} className="rotate-45" />
                      </span>
                    )}
                  </div>

                  {/* 悬停/菜单打开时展示操作按钮；默认展示代码索引状态（若有） */}
                  <div className="flex items-center gap-1 shrink-0">
                    {projectIndexStatus !== null && (
                      <div className="sidebar-project-header__status">
                        <SidebarStatusDot
                          tone={projectIndexStatus === 'building' ? 'accent' : 'warning'}
                          label={projectIndexStatus === 'building' ? '正在建立代码索引' : '代码索引不可用'}
                          isPulsing={projectIndexStatus === 'building'}
                          onActivate={openCodeIndexSettings}
                        />
                      </div>
                    )}

                    <div
                      className="sidebar-project-header__actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DropdownMenu
                        isMenuOpen={isMenuOpen}
                        onOpenChange={(open) => {
                          setOpenMenuProjectPath(open ? projectPath : null)
                          if (open) {
                            if (hoverTimerRef.current) {
                              clearTimeout(hoverTimerRef.current)
                              hoverTimerRef.current = null
                            }
                            setHoveredProject(null)
                          }
                        }}
                        button={{
                          label: '项目操作',
                          icon: <span className="sidebar-session-menu__ellipsis" aria-hidden>⋯</span>,
                          variant: 'ghost',
                          size: 'sm',
                          isIconOnly: true,
                          tooltip: '项目操作'
                        }}
                      >
                        <DropdownMenuItem
                          label={isPinned ? '取消置顶' : '置顶'}
                          onClick={() => {
                            setOpenMenuProjectPath(null)
                            togglePinProject(projectPath)
                          }}
                        />
                        <DropdownMenuItem
                          label="复制项目路径"
                          onClick={() => {
                            setOpenMenuProjectPath(null)
                            void navigator.clipboard.writeText(projectPath)
                          }}
                        />
                        <DropdownMenuItem
                          label="归档"
                          onClick={() => {
                            setOpenMenuProjectPath(null)
                            toggleArchiveProject(projectPath)
                          }}
                        />
                        <DropdownMenuItem
                          label="删除"
                          style={{ color: 'var(--color-error)' }}
                          onClick={() => {
                            setOpenMenuProjectPath(null)
                            void handleDeleteProject(projectPath, filteredProjectSessions)
                          }}
                        />
                      </DropdownMenu>

                      <button
                        type="button"
                        className="sidebar-project-add-btn w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
                        title="在此项目下新建会话"
                        aria-label="在此项目下新建会话"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (hoverTimerRef.current) {
                            clearTimeout(hoverTimerRef.current)
                            hoverTimerRef.current = null
                          }
                          setHoveredProject(null)
                          void createNewSession(projectPath)
                        }}
                      >
                        <PlusIcon size={14} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* 项目内会话列表 */}
                {isExpanded && (
                  <div className="sidebar-project-children pl-2">
                    {visibleSessions.map((session) => renderSessionRow(session))}
                    {showMoreToggle && (
                      <Button
                        label={isSessionListExpanded ? '收起' : '显示更多'}
                        variant="ghost"
                        size="sm"
                        width="100%"
                        type="button"
                        className="w-full text-left pl-[19px] pr-2 py-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
                        onClick={(e) => {
                          e.stopPropagation()
                          setExpandedSessionLists(prev => ({
                            ...prev,
                            [projectPath]: !isSessionListExpanded
                          }))
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {/* 已归档项目折叠分区 */}
          {archivedProjectEntries.length > 0 && (
            <div className="sidebar-archived-projects-section mt-2 pt-2 border-t border-border-subtle">
              <div
                className="flex items-center justify-between px-2 py-1 text-xs font-medium text-text-muted cursor-pointer hover:text-text-secondary select-none"
                onClick={() => setIsArchivedSectionExpanded(prev => !prev)}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`transition-transform duration-150 inline-block shrink-0 ${
                      isArchivedSectionExpanded ? 'rotate-0' : '-rotate-90'
                    }`}
                  >
                    <ChevronDownIcon size={12} />
                  </span>
                  <span>已归档项目 ({archivedProjectEntries.length})</span>
                </div>
              </div>
              {isArchivedSectionExpanded && (
                <div className="mt-1">
                  {archivedProjectEntries.map(([projectPath, projectSessions]) => {
                    const filteredProjectSessions = projectSessions.filter(filterSessionMatch)
                    if (filteredProjectSessions.length === 0 && normalizedFilter) return null
                    const isExpanded = expandedProjects[projectPath] !== false
                    const isMenuOpen = openMenuProjectPath === projectPath

                    return (
                      <div key={projectPath} className="sidebar-project-group mb-0.5 opacity-80 hover:opacity-100 transition-opacity">
                        <div
                          className={`sidebar-project-header flex items-center justify-between px-2 py-1 rounded cursor-pointer hover:bg-surface-hover group transition-colors select-none ${
                            isMenuOpen ? 'sidebar-project-header--menu-open' : ''
                          }`}
                          onClick={() => toggleProjectExpand(projectPath)}
                        >
                          <div className="flex items-center gap-1.5 min-w-0 flex-1">
                            <span
                              className={`text-text-muted transition-transform duration-150 inline-block shrink-0 ${
                                isExpanded ? 'rotate-0' : '-rotate-90'
                              }`}
                            >
                              <ChevronDownIcon size={13} />
                            </span>
                            <span className="text-[13px] font-semibold text-text-muted truncate">
                              {getProjectName(projectPath)}
                            </span>
                          </div>

                          <div
                            className="sidebar-project-header__actions"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <DropdownMenu
                              isMenuOpen={isMenuOpen}
                              onOpenChange={(open) => setOpenMenuProjectPath(open ? projectPath : null)}
                              button={{
                                label: '项目操作',
                                icon: <span className="sidebar-session-menu__ellipsis" aria-hidden>⋯</span>,
                                variant: 'ghost',
                                size: 'sm',
                                isIconOnly: true,
                                tooltip: '项目操作'
                              }}
                            >
                              <DropdownMenuItem
                                label="取消归档"
                                onClick={() => {
                                  setOpenMenuProjectPath(null)
                                  toggleArchiveProject(projectPath)
                                }}
                              />
                              <DropdownMenuItem
                                label="复制项目路径"
                                onClick={() => {
                                  setOpenMenuProjectPath(null)
                                  void navigator.clipboard.writeText(projectPath)
                                }}
                              />
                              <DropdownMenuItem
                                label="删除"
                                style={{ color: 'var(--color-error)' }}
                                onClick={() => {
                                  setOpenMenuProjectPath(null)
                                  void handleDeleteProject(projectPath, filteredProjectSessions)
                                }}
                              />
                            </DropdownMenu>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="sidebar-project-children pl-2">
                            {filteredProjectSessions.map((session) => renderSessionRow(session))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </SideNavSection>
      </SideNav>

      {/* 鼠标在项目节点停留超过 1s 弹出的项目详情小窗口，使用 Portal 挂载到 body 防止被侧栏 overflow 裁剪 */}
      {typeof document !== 'undefined' && hoveredProject && createPortal(
        <div
          className="sidebar-project-popover fixed z-[9999] p-3 rounded-lg flex flex-col gap-2 min-w-[220px] max-w-[320px]"
          style={{
            left: Math.min(window.innerWidth - 320, getSidebarRightEdge() + 8),
            top: Math.max(8, Math.min(window.innerHeight - 130, hoveredProject.rect.top - 2))
          }}
          onMouseEnter={handlePopoverMouseEnter}
          onMouseLeave={handlePopoverMouseLeave}
        >
          {/* 1. 项目名字 */}
          <div className="flex items-center gap-2 min-w-0">
            <FolderIcon size={15} className="text-text-secondary shrink-0" />
            <span className="text-sm font-semibold text-text-primary truncate">
              {getProjectName(hoveredProject.path)}
            </span>
          </div>

          {/* 2. 几个任务 */}
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <TerminalIcon size={14} className="text-text-muted shrink-0" />
            <span className="tabular-nums">
              {hoveredProject.sessions.length} 个任务
            </span>
          </div>

          {/* 3. 最下面的路径：可点击，hover效果，点击直接打开当前项目根目录 */}
          <div
            role="button"
            tabIndex={0}
            title={hoveredProject.path}
            className="sidebar-project-popover__path flex items-center gap-1.5 px-2 py-1 -mx-1 rounded text-xs text-text-muted hover:text-text-primary hover:bg-surface-hover cursor-pointer transition-colors group/path min-w-0"
            onClick={(e) => {
              e.stopPropagation()
              void handleOpenProjectDirectory(hoveredProject.path)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                void handleOpenProjectDirectory(hoveredProject.path)
              }
            }}
          >
            <FolderIcon size={13} className="shrink-0 text-text-muted group-hover/path:text-text-primary transition-colors" />
            <span className="truncate group-hover/path:underline decoration-border-subtle underline-offset-2">
              {hoveredProject.path}
            </span>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
})

export interface SidebarProps {
  updateSnapshot?: AppUpdateSnapshot | null
}

export const Sidebar: React.FC<SidebarProps> = ({ updateSnapshot = null }) => {
  const sidebarCollapsed = useLayoutStore(state => state.sidebarCollapsed)
  const sidebarWidth = useLayoutStore(state => state.sidebarWidth)
  const [isResizing, setIsResizing] = useState(false)
  const [searchTriggerCount, setSearchTriggerCount] = useState(0)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isResizing) return

    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current
      const el = shellRef.current
      if (!drag || !el) return
      el.style.width = `${Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, drag.startWidth + (e.clientX - drag.startX)))}px`
    }

    const onUp = () => {
      dragRef.current = null
      setIsResizing(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isResizing])

  /** 拖拽结束：提交最终宽度到 store */
  useEffect(() => {
    if (isResizing) return
    const el = shellRef.current
    if (!el) return
    const w = el.style.width
    if (!w) return
    const finalWidth = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Number.parseFloat(w)))
    if (Number.isFinite(finalWidth) && finalWidth !== sidebarWidth) {
      useLayoutStore.getState().setSidebarWidth(finalWidth)
    }
  }, [isResizing, sidebarWidth])

  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = {
      startX: e.clientX,
      startWidth: useLayoutStore.getState().sidebarWidth
    }
    setIsResizing(true)
  }

  const shellClass = [
    'sidebar-shell',
    sidebarCollapsed ? 'sidebar-shell--collapsed' : '',
    isResizing ? 'sidebar-shell--resizing' : ''
  ].filter(Boolean).join(' ')

  return (
    <div
      ref={shellRef}
      className={shellClass}
      style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
      aria-hidden={sidebarCollapsed}
    >
      <div
        className="sidebar-shell__inner"
        style={{
          width: sidebarWidth,
          transform: sidebarCollapsed ? 'translateX(-100%)' : 'translateX(0)'
        }}
      >
        {/* 顶行：窗口拖拽区 + 品牌 Logo + 检索 + 折叠按钮 */}
        <div className="sidebar-topbar">
          <div className="sidebar-topbar__brand">
            <NovaLogo size={24} />
          </div>
          <div className="sidebar-topbar__actions ml-auto flex items-center gap-1">
            <IconButton
              label="会话检索 (Ctrl+P)"
              icon={<SearchIcon size={15} />}
              variant="ghost"
              size="sm"
              tooltip="会话检索 (Ctrl+P)"
              onClick={() => setSearchTriggerCount(prev => prev + 1)}
            />
            <IconButton
              label="折叠会话导航"
              icon={<PanelLeftIcon size={16} />}
              variant="ghost"
              size="sm"
              className="sidebar-topbar__toggle"
              tooltip="折叠会话导航"
              onClick={() => useLayoutStore.getState().toggleSidebar()}
            />
          </div>
        </div>

        {/* 导航区域 */}
        <div className="sidebar-shell__nav">
          <SidebarSessions
            updateSnapshot={updateSnapshot}
            searchTriggerCount={searchTriggerCount}
          />
        </div>
      </div>
      {!sidebarCollapsed && (
        <div
          className="sidebar-shell__resize-handle"
          onMouseDown={onResizeMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整会话导航宽度"
        />
      )}
    </div>
  )
}
