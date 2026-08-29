import React, { useState, useRef, useEffect, useMemo } from 'react'
import { useChatStore } from '../stores/useChatStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useLayoutStore, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX } from '../stores/useLayoutStore'
import type { PrimarySession, Session } from '../../shared/session/types'
import {
  SESSION_PLACEHOLDER_TITLE,
  SESSION_TITLE_MAX_LENGTH,
  clampSessionTitle
} from '../../shared/session/title'
import { NovaLogo, FolderIcon, SettingsIcon, PlusIcon, PinIcon, PanelLeftIcon } from './Icons'
import { Button } from '@astryxdesign/core/Button'
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu'
import { IconButton } from '@astryxdesign/core/IconButton'
import { TextInput } from '@astryxdesign/core/TextInput'
import { SideNav, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { useRunStore } from '../stores/useRunStore'
import { useAgentStore } from '../stores/useAgentStore'
import { selectCurrentCodeIndexStatus, useCodeIndexStore } from '../stores/useCodeIndexStore'
import { listPinnedSessions, listSidebarRootSessions, resolveSidebarActiveSessionId } from '../features/subagents/sidebarSessions'
import type { AppUpdateSnapshot } from '../../shared/update'
import { UpdateIndicator } from '../features/update/UpdateIndicator'
import './Sidebar.css'

/** 每个项目下默认展示的最新会话数 */
const SIDEBAR_SESSION_PREVIEW_COUNT = 5

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

/** 侧栏状态色点：不用 Astryx StatusDot/Kbd，避免 Vite 单独预构建入口拉裂 React */
function SidebarStatusDot({
  tone,
  label,
  isPulsing = false,
  onActivate
}: {
  tone: 'warning' | 'accent'
  label: string
  isPulsing?: boolean
  onActivate?: () => void
}) {
  const color = tone === 'warning' ? 'var(--color-warning, #d97706)' : 'var(--color-accent, #3b82f6)'
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

/** 会话树内容：不订阅布局宽度，拖拽调宽时仅壳层重绘 */
interface SidebarSessionsProps {
  updateSnapshot: AppUpdateSnapshot | null
}

const SidebarSessions = React.memo(function SidebarSessions({ updateSnapshot }: SidebarSessionsProps) {
  const sessions = useChatStore(state => state.sessions)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const createNewSession = useChatStore(state => state.createNewSession)
  const selectSession = useChatStore(state => state.selectSession)
  const deleteSession = useChatStore(state => state.deleteSession)
  const renameSession = useChatStore(state => state.renameSession)
  const setSessionPinned = useChatStore(state => state.setSessionPinned)
  const currentProject = useSettingsStore(state => state.currentProject)
  const selectProject = useSettingsStore(state => state.selectProject)
  const setConfigModalOpen = useSettingsStore(state => state.setConfigModalOpen)
  const openCodeIndexSettings = useSettingsStore(state => state.openCodeIndexSettings)
  const codeIndexSnapshot = useCodeIndexStore(selectCurrentCodeIndexStatus)
  const waitingSessions = useRunStore(state => state.waitingSessions)
  const snapshotsByRunId = useRunStore(state => state.snapshotsByRunId)
  const cancelExecution = useAgentStore(state => state.cancelExecution)

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
  /** Escape 取消时阻止紧随其后的 blur 误提交 */
  const editCancelledRef = useRef(false)

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

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

  const sidebarActiveSessionId = resolveSidebarActiveSessionId(sessions, currentSessionId)

  const projectGroups = listSidebarRootSessions(sessions).reduce((acc, session) => {
    const p = session.workspaceRoot
    if (!acc[p]) acc[p] = []
    acc[p].push(session)
    return acc
  }, {} as Record<string, ReturnType<typeof listSidebarRootSessions>>)

  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(
    Object.keys(projectGroups).reduce((acc, p) => ({ ...acc, [p]: true }), {})
  )
  /** 每个项目会话列表是否已点「显示更多」（与项目文件夹开合独立） */
  const [expandedSessionLists, setExpandedSessionLists] = useState<Record<string, boolean>>({})

  const getProjectName = (pathStr: string) => {
    const parts = pathStr.split(/[\\/]/)
    return parts[parts.length - 1] || pathStr
  }

  const getDisplayTitle = (session: Session) => {
    return session.title || SESSION_PLACEHOLDER_TITLE
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  /** 相对时间：刚刚 / N 分钟 / N 小时 / N 天，超过 30 天回退到日期 */
  const formatRelativeTime = (ts: number) => {
    const minutes = Math.floor((Date.now() - ts) / 60000)
    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes} 分钟`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} 小时`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days} 天`
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()}`
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
      // 主进程拒绝（如会话正在运行）：给出可见反馈，不能静默关闭确认框
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

  /** 置顶分区的会话子集（顺序沿用 store 列表） */
  const pinnedSessions = listPinnedSessions(sessions)

  const togglePin = (session: PrimarySession) => {
    setOpenMenuSessionId(null)
    void setSessionPinned(session.id, !session.pinned)
  }

  /** 单条会话行：置顶分区与项目分组共用同一渲染，避免两套行实现各自漂移 */
  const renderSessionRow = (session: PrimarySession, leadingIcon?: React.ReactNode) => {
    const isActive = session.id === sidebarActiveSessionId
    const isEditing = editingId === session.id
    const displayTitle = getDisplayTitle(session)
    const waitingBadge = waitingSessions.find(w => w.sessionId === session.id)
    const showWaiting = !!waitingBadge && !isActive
    const runningBadge = runningSessions.find(r => r.sessionId === session.id)
    const showRunning = !!runningBadge && !isActive
    const detailTitle = `${displayTitle}\n${formatTime(session.updatedAt)}${session.messageCount > 0 ? ` · ${session.messageCount} 条对话` : ''}`

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
            className="flex-1 min-w-0 text-sm px-1 py-0.5 rounded border border-border-warm text-text-primary bg-bg-card outline-none focus:border-text-muted"
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
              <>
                {showWaiting && (
                  <SidebarStatusDot tone="warning" label="等待你处理" isPulsing />
                )}
                {showRunning && (
                  <SidebarStatusDot tone="accent" label="运行中" isPulsing />
                )}
                {!showWaiting && !showRunning && (
                  <span className="sidebar-session-row__meta text-[11px] text-text-muted shrink-0">
                    {formatRelativeTime(session.updatedAt)}
                  </span>
                )}
              </>
            )}
          />
        )}
        {!isEditing && (
          <div className="sidebar-session-row__actions">
            {/*
             * 菜单走 Astryx DropdownMenu（原生 popover 顶层渲染）：
             * 会话行位于项目折叠容器的 overflow:hidden 内，
             * 自绘 absolute 面板会被裁剪，顶层弹出不受任何祖先裁剪。
             */}
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

  return (
    <SideNav
      className="bg-[var(--bg-sidebar)] select-none sidebar-astryx-nav"
      style={{ width: '100%' }}
      topContent={(
        <>
          <SideNavItem
            label="新对话"
            icon={<PlusIcon size={16} />}
            onClick={() => createNewSession(currentProject || undefined)}
            endContent={(
              <span className="text-[11px] text-text-muted tabular-nums">
                {newSessionShortcutLabel()}
              </span>
            )}
          />
          <SideNavItem
            label="添加工作区"
            icon={<FolderIcon size={16} />}
            onClick={selectProject}
          />
        </>
      )}
      footer={(
        <div className="sidebar-footer-actions">
          <UpdateIndicator snapshot={updateSnapshot} />
          <SideNavItem
            label="设置"
            icon={<SettingsIcon size={18} />}
            onClick={() => setConfigModalOpen(true)}
          />
        </div>
      )}
    >
      {pinnedSessions.length > 0 && (
        <SideNavSection title="置顶">
          {pinnedSessions.map((session) => renderSessionRow(session, <PinIcon size={16} />))}
        </SideNavSection>
      )}
      <SideNavSection title="会话">
        {Object.entries(projectGroups).map(([projectPath, projectSessions]) => {
          const isExpanded = expandedProjects[projectPath] !== false
          const selectedIndex = projectSessions.findIndex(session => session.id === sidebarActiveSessionId)
          const selectedBeyondPreview = selectedIndex >= SIDEBAR_SESSION_PREVIEW_COUNT
          const userExpandedSessions = expandedSessionLists[projectPath] === true
          const isSessionListExpanded = userExpandedSessions || selectedBeyondPreview
          const visibleSessions =
            isSessionListExpanded || projectSessions.length <= SIDEBAR_SESSION_PREVIEW_COUNT
              ? projectSessions
              : projectSessions.slice(0, SIDEBAR_SESSION_PREVIEW_COUNT)
          const showMoreToggle = projectSessions.length > SIDEBAR_SESSION_PREVIEW_COUNT
          const projectIndexStatus = codeIndexSnapshot?.enabled === true &&
            codeIndexSnapshot.workspaceRoot === projectPath &&
            (codeIndexSnapshot.status === 'building' ||
              codeIndexSnapshot.status === 'degraded' ||
              codeIndexSnapshot.status === 'unavailable')
              ? codeIndexSnapshot.status
              : null

          /*
           * 项目行默认右侧留白，任务数 /「+」/ 折叠箭头都归入悬浮簇，hover 或聚焦时出现；
           * 折叠箭头由 CSS 控制显隐（Astryx 把它渲染为主按钮的最后一个 span）。
           * 「+」保持行级兄弟，避免 endContent 嵌套 button。
           */
          return (
            <div key={projectPath} className="sidebar-project-row">
              <SideNavItem
                label={getProjectName(projectPath)}
                icon={<FolderIcon size={16} />}
                size="sm"
                collapsible={{
                  isCollapsed: !isExpanded,
                  onCollapsedChange: (collapsed) => {
                    setExpandedProjects(prev => ({ ...prev, [projectPath]: !collapsed }))
                  }
                }}
              >
                {visibleSessions.map((session) => renderSessionRow(session))}
                {showMoreToggle && (
                  <Button
                    label={isSessionListExpanded ? '收起' : '显示更多'}
                    variant="ghost"
                    size="sm"
                    width="100%"
                    type="button"
                    className="w-full text-left px-3 py-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
                    onClick={(e) => {
                      e.stopPropagation()
                      setExpandedSessionLists(prev => ({
                        ...prev,
                        [projectPath]: !isSessionListExpanded
                      }))
                    }}
                  />
                )}
              </SideNavItem>
              <div className="sidebar-project-row__hover-cluster">
                {projectIndexStatus === null ? (
                  <span className="sidebar-project-row__count text-[11px] text-text-muted">
                    {projectSessions.length} 个任务
                  </span>
                ) : (
                  <SidebarStatusDot
                    tone={projectIndexStatus === 'building' ? 'accent' : 'warning'}
                    label={projectIndexStatus === 'building' ? '正在建立代码索引' : '代码索引不可用'}
                    isPulsing={projectIndexStatus === 'building'}
                    onActivate={openCodeIndexSettings}
                  />
                )}
                <IconButton
                  label="在此项目下新建会话"
                  icon={<PlusIcon size={16} />}
                  variant="ghost"
                  size="sm"
                  tooltip="在此项目下新建会话"
                  onClick={() => createNewSession(projectPath)}
                />
              </div>
            </div>
          )
        })}
      </SideNavSection>
    </SideNav>
  )
})

export interface SidebarProps {
  updateSnapshot?: AppUpdateSnapshot | null
}

export const Sidebar: React.FC<SidebarProps> = ({ updateSnapshot = null }) => {
  const sidebarCollapsed = useLayoutStore(state => state.sidebarCollapsed)
  const sidebarWidth = useLayoutStore(state => state.sidebarWidth)
  const [isResizing, setIsResizing] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  /** 拖拽期间宽度直写壳层 DOM，避免每次 mousemove 触发 store 重渲染 */
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

  /** 拖拽结束：一次性提交最终宽度到 store（含持久化） */
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
        {/* 侧栏自己的顶行：品牌 + 折叠开关；无贯穿顶栏后兼作本栏的窗口拖拽区 */}
        <div className="sidebar-topbar">
          <NovaLogo size={18} />
          <span className="sidebar-topbar__title">Nova Agent</span>
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
        {/* 顶行占位 40px，导航区占剩余高度 */}
        <div className="sidebar-shell__nav">
          <SidebarSessions updateSnapshot={updateSnapshot} />
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
