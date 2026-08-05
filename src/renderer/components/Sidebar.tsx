import React, { useState, useRef, useEffect, useMemo } from 'react'
import { useChatStore } from '../stores/useChatStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useLayoutStore } from '../stores/useLayoutStore'
import type { Session } from '../../shared/session/types'
import {
  SESSION_PLACEHOLDER_TITLE,
  SESSION_TITLE_MAX_LENGTH,
  clampSessionTitle
} from '../../shared/session/title'
import { NovaLogo, FolderIcon, SettingsIcon, PlusIcon, ChevronIcon, TrashIcon, EditIcon } from './Icons'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { TextInput } from '@astryxdesign/core/TextInput'
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { useRunStore } from '../stores/useRunStore'
import { useAgentStore } from '../stores/useAgentStore'
import { useSubagentProjectionStore } from '../features/subagents/projection'
import {
  buildSessionForest,
  flattenSessionForest,
  sessionTreeContains
} from '../features/subagents/sessionTree'
import './Sidebar.css'

/** 每个项目下默认展示的最新会话数（对齐 Cursor「显示更多」） */
const SIDEBAR_SESSION_PREVIEW_COUNT = 5

/** 会话树内容：不订阅布局宽度，拖拽调宽时仅壳层重绘 */
const SidebarSessions = React.memo(function SidebarSessions() {
  const sessions = useChatStore(state => state.sessions)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const createNewSession = useChatStore(state => state.createNewSession)
  const selectSession = useChatStore(state => state.selectSession)
  const deleteSession = useChatStore(state => state.deleteSession)
  const renameSession = useChatStore(state => state.renameSession)
  const currentProject = useSettingsStore(state => state.currentProject)
  const selectProject = useSettingsStore(state => state.selectProject)
  const setConfigModalOpen = useSettingsStore(state => state.setConfigModalOpen)
  const waitingSessions = useRunStore(state => state.waitingSessions)
  const snapshotsByRunId = useRunStore(state => state.snapshotsByRunId)
  const cancelExecution = useAgentStore(state => state.cancelExecution)
  const subagentProjections = useSubagentProjectionStore(state => state.byChildSessionId)

  /**
   * 后台运行中会话徽标：从 snapshotsByRunId 派生，取所有非终态活跃 run，
   * 按 sessionId 聚合（每个会话只显示一个运行中徽标）。
   * 焦点会话自身的运行态由 ChatPanel 的停止按钮表达，不在此徽标范围。
   */
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
  const editInputRef = useRef<HTMLInputElement>(null)
  /** Escape 取消时阻止紧随其后的 blur 误提交 */
  const editCancelledRef = useRef(false)

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  // 先按 durable lineage 建树，再按根会话工作区分组；worktree child 仍归父会话。
  const projectGroups = buildSessionForest(sessions).reduce((acc, node) => {
    const p = node.session.workspaceRoot
    if (!acc[p]) acc[p] = []
    acc[p].push(node)
    return acc
  }, {} as Record<string, ReturnType<typeof buildSessionForest>>)

  // 控制每个项目的展开/收起状态 (默认都展开)
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(
    Object.keys(projectGroups).reduce((acc, p) => ({ ...acc, [p]: true }), {})
  )
  /** 每个项目会话列表是否已点「显示更多」（与项目文件夹开合独立） */
  const [expandedSessionLists, setExpandedSessionLists] = useState<Record<string, boolean>>({})

  const toggleProject = (p: string) => {
    setExpandedProjects(prev => ({ ...prev, [p]: prev[p] === false }))
  }

  const getProjectName = (pathStr: string) => {
    const parts = pathStr.split(/[\\/]/)
    return parts[parts.length - 1] || pathStr
  }

  /** 侧边栏会话标题：持久化 title 为唯一来源，极端缺字段时回退占位名 */
  const getDisplayTitle = (session: Session) => {
    return session.title || SESSION_PLACEHOLDER_TITLE
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  /** 相对时间（对齐 Codex 侧边栏）：刚刚 / N 分钟 / N 小时 / N 天，超过 30 天回退到日期 */
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

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    const response = await window.api.invoke('dialog:confirm', {
      title: '删除会话',
      message: '确定要删除这个会话吗？',
      detail: '删除后无法恢复。'
    })
    if (response === 1) {
      deleteSession(sessionId)
    }
  }

  const startEditing = (e: React.MouseEvent, session: Session) => {
    e.stopPropagation()
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

  return (
    <SideNav
      className="bg-[var(--bg-sidebar)] select-none"
      style={{ width: '100%' }}
      header={(
        <SideNavHeading heading="Nova Agent" icon={<NovaLogo size={20} />} />
      )}
      topContent={(
        <div className="px-3 py-3">
          <Button
            label="新对话"
            variant="secondary"
            icon={<PlusIcon size={14} className="text-text-secondary group-hover:text-text-primary transition-colors" />}
            width="100%"
            className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-full bg-white border border-border-warm shadow-sm hover:shadow-md hover:border-gray-300 transition-all text-sm font-medium text-text-primary group"
            onClick={() => createNewSession(currentProject || undefined)}
            tooltip="新建对话"
          />
        </div>
      )}
      footer={(
        <SideNavItem
          label="设置"
          icon={(
            <span className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
              <SettingsIcon size={16} />
            </span>
          )}
          onClick={() => setConfigModalOpen(true)}
        />
      )}
    >
      <SideNavSection
        title="项目工作区"
        endContent={(
          <IconButton
            label="添加新工作区"
            icon={<PlusIcon size={12} />}
            variant="ghost"
            size="sm"
            className="p-1 rounded hover:bg-gray-200/50 text-text-muted hover:text-text-primary transition-colors"
            tooltip="添加新工作区"
            onClick={selectProject}
          />
        )}
      >
        {Object.entries(projectGroups).map(([projectPath, sessionForest]) => {
          const isExpanded = expandedProjects[projectPath] !== false
          // 选中会话在预览区之外时强制展开，避免选中项被藏住
          const selectedIndex = sessionForest.findIndex(node => sessionTreeContains(node, currentSessionId))
          const selectedBeyondPreview = selectedIndex >= SIDEBAR_SESSION_PREVIEW_COUNT
          const userExpandedSessions = expandedSessionLists[projectPath] === true
          const isSessionListExpanded = userExpandedSessions || selectedBeyondPreview
          const visibleRoots =
            isSessionListExpanded || sessionForest.length <= SIDEBAR_SESSION_PREVIEW_COUNT
              ? sessionForest
              : sessionForest.slice(0, SIDEBAR_SESSION_PREVIEW_COUNT)
          const visibleSessions = flattenSessionForest(visibleRoots)
          const showMoreToggle = sessionForest.length > SIDEBAR_SESSION_PREVIEW_COUNT

          /*
           * 「+」与 SideNavItem 是行级兄弟而非 endContent：
           * SideNavItem 的 endContent 渲染在主按钮内部，放 IconButton 会形成
           * button 嵌 button 的无效交互元素嵌套。外层 .group 驱动 hover 显示。
           */
          return (
            <div key={projectPath} className="group flex flex-col">
              <div className="flex items-center gap-1">
                <div className="flex-1 min-w-0">
                  <SideNavItem
                    label={getProjectName(projectPath)}
                    icon={<FolderIcon size={14} className="text-text-secondary shrink-0" />}
                    onClick={() => toggleProject(projectPath)}
                    endContent={(
                      <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
                        <span className="group-hover:hidden">{sessionForest.length} 个任务</span>
                        <ChevronIcon
                          size={12}
                          direction={isExpanded ? 'down' : 'right'}
                          style={{ transition: 'transform 0.2s' }}
                          className="text-text-muted shrink-0"
                        />
                      </span>
                    )}
                  />
                </div>
                <IconButton
                  label="在此项目下新建会话"
                  icon={<PlusIcon size={12} />}
                  variant="ghost"
                  size="sm"
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-300/50 text-text-secondary transition-all shrink-0"
                  tooltip="在此项目下新建会话"
                  onClick={(e) => {
                    e.stopPropagation()
                    createNewSession(projectPath)
                  }}
                />
              </div>

              <AnimatePresence initial={false}>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: "easeInOut" }}
                    className="overflow-hidden"
                  >
                    <div className="pl-6 pr-1 py-1 space-y-1 border-l border-border-cream ml-[11px]">
                      {visibleSessions.map(({ session, depth }) => {
                        const isActive = session.id === currentSessionId
                        const isEditing = editingId === session.id
                        const displayTitle = getDisplayTitle(session)
                        const waitingBadge = waitingSessions.find(w => w.sessionId === session.id)
                        const showWaiting = !!waitingBadge && !isActive
                        const runningBadge = runningSessions.find(r => r.sessionId === session.id)
                        const showRunning = !!runningBadge && !isActive
                        const childProjection = session.kind === 'subagent'
                          ? subagentProjections[session.id]
                          : undefined
                        const childStatus = childProjection
                          ? ({
                              queued: ['○', '等待开始'],
                              running: ['●', '运行中'],
                              waiting_user: ['!', '等待授权'],
                              retrying: ['●', '重试中'],
                              resuming: ['●', '恢复中'],
                              cancelling: ['◌', '停止中'],
                              completed: ['✓', '已完成'],
                              failed: ['×', '失败'],
                              cancelled: ['■', '已取消'],
                              interrupted: ['◇', '已中断'],
                              record_missing: ['?', '记录不可用']
                            } as const)[childProjection.status]
                          : undefined

                        return (
                          <div
                            key={session.id}
                            onClick={() => !isEditing && selectSession(session.id)}
                            className={`group/session relative flex items-center gap-1 px-3 py-1.5 rounded-md cursor-pointer transition-colors ${
                              isActive ? 'bg-white shadow-sm border border-border-warm' : 'hover:bg-gray-200/50'
                            }`}
                            style={{ marginLeft: `${depth * 14}px` }}
                            title={showWaiting ? '等待你处理' : undefined}
                          >
                            {isEditing ? (
                              <TextInput
                                ref={editInputRef}
                                label="重命名会话"
                                isLabelHidden
                                size="sm"
                                width="100%"
                                className="flex-1 min-w-0 text-sm px-1 py-0.5 rounded border border-border-warm text-text-primary bg-white outline-none focus:border-gray-400"
                                value={editValue}
                                onChange={(value) => setEditValue(value.slice(0, SESSION_TITLE_MAX_LENGTH))}
                                onKeyDown={(e) => handleEditKeyDown(e, session.id)}
                                onBlur={() => void submitRename(session.id)}
                                onClick={(e) => e.stopPropagation()}
                              />
                            ) : (
                              <Button
                                label={displayTitle}
                                variant="ghost"
                                size="sm"
                                type="button"
                                className={`flex items-center gap-1.5 min-w-0 flex-1 text-left rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${
                                  isActive ? 'text-text-primary font-medium' : 'text-text-secondary'
                                }`}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void selectSession(session.id)
                                }}
                                aria-current={isActive ? 'page' : undefined}
                                aria-label={`打开会话 ${displayTitle}${childStatus ? `，${childStatus[1]}` : ''}`}
                                icon={childStatus ? (
                                  <span
                                    className="text-[11px] text-text-muted shrink-0"
                                    title={childStatus[1]}
                                  >
                                    <span aria-hidden="true">{childStatus[0]}</span>
                                    <span className="sr-only">{childStatus[1]}</span>
                                  </span>
                                ) : undefined}
                                tooltip={`${displayTitle}\n${formatTime(session.updatedAt)}${session.messageCount > 0 ? ` · ${session.messageCount} 条对话` : ''}`}
                              />
                            )}
                            {showWaiting && (
                              <div className="flex items-center gap-1 shrink-0">
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200"
                                  title="等待你处理"
                                >
                                  等待你处理
                                </span>
                                <Button
                                  label="停止"
                                  variant="ghost"
                                  size="sm"
                                  className="text-[10px] px-1.5 py-0.5 rounded border border-border-warm text-text-secondary hover:bg-gray-100"
                                  tooltip="停止此 XForge 运行"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    void cancelExecution(waitingBadge?.runId)
                                  }}
                                />
                              </div>
                            )}
                            {showRunning && (
                              <div className="flex items-center gap-1 shrink-0">
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 flex items-center gap-1"
                                  title="后台运行中"
                                >
                                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                                  运行中
                                </span>
                                <Button
                                  label="停止"
                                  variant="ghost"
                                  size="sm"
                                  className="text-[10px] px-1.5 py-0.5 rounded border border-border-warm text-text-secondary hover:bg-gray-100"
                                  tooltip="停止此会话的后台运行"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    void cancelExecution(runningBadge?.runId)
                                  }}
                                />
                              </div>
                            )}
                            {!showWaiting && !showRunning && !isEditing && (
                              <span className="text-[11px] text-text-muted shrink-0 group-hover/session:hidden group-focus-within/session:hidden">
                                {formatRelativeTime(session.updatedAt)}
                              </span>
                            )}
                            {!isEditing && (
                              <div className="hidden group-hover/session:flex group-focus-within/session:flex items-center shrink-0">
                                <IconButton
                                  label="重命名会话"
                                  icon={<EditIcon size={12} />}
                                  variant="ghost"
                                  size="sm"
                                  className="p-1 rounded hover:bg-gray-300/50 text-text-muted hover:text-text-primary transition-all"
                                  tooltip="重命名会话"
                                  onClick={(e) => startEditing(e, session)}
                                />
                                {session.kind === 'primary' ? (
                                  <IconButton
                                    label="删除会话"
                                    icon={<TrashIcon size={12} />}
                                    variant="ghost"
                                    size="sm"
                                    className="p-1 rounded hover:bg-gray-300/50 text-text-muted hover:text-red-500 transition-all"
                                    tooltip="删除会话"
                                    onClick={(e) => handleDelete(e, session.id)}
                                  />
                                ) : null}
                              </div>
                            )}
                          </div>
                        )
                      })}
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
                            // 收起只清用户态；选中项仍在预览区外时由 selectedBeyondPreview 继续强制展开
                            setExpandedSessionLists(prev => ({
                              ...prev,
                              [projectPath]: !isSessionListExpanded
                            }))
                          }}
                        />
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
      </SideNavSection>
    </SideNav>
  )
})

export const Sidebar: React.FC = () => {
  const sidebarCollapsed = useLayoutStore(state => state.sidebarCollapsed)
  const sidebarWidth = useLayoutStore(state => state.sidebarWidth)
  const [isResizing, setIsResizing] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    if (!isResizing) return

    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      useLayoutStore.getState().setSidebarWidth(drag.startWidth + (e.clientX - drag.startX))
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
      className={shellClass}
      style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
      aria-hidden={sidebarCollapsed}
    >
      <div className="sidebar-shell__inner" style={{ width: sidebarWidth }}>
        <SidebarSessions />
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
