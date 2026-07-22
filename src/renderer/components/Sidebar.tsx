import React, { useState, useRef, useEffect, useMemo } from 'react'
import { useChatStore } from '../stores/useChatStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import type { Session } from '../../shared/session/types'
import {
  SESSION_PLACEHOLDER_TITLE,
  SESSION_TITLE_MAX_LENGTH,
  clampSessionTitle
} from '../../shared/session/title'
import { NovaLogo, FolderIcon, SettingsIcon, PlusIcon, ChevronIcon, TrashIcon, EditIcon } from './Icons'
import { motion, AnimatePresence } from 'framer-motion'
import { useRunStore } from '../stores/useRunStore'
import { useAgentStore } from '../stores/useAgentStore'

/** 每个项目下默认展示的最新会话数（对齐 Cursor「显示更多」） */
const SIDEBAR_SESSION_PREVIEW_COUNT = 5

export const Sidebar: React.FC = () => {
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

  /**
   * 后台运行中会话徽标：从 snapshotsByRunId 派生，取所有 status==='running' 的非终态 run，
   * 按 sessionId 聚合（每个会话只显示一个运行中徽标）。
   * 焦点会话自身的运行态由 ChatPanel 的停止按钮表达，不在此徽标范围。
   */
  const runningSessions = useMemo(() => {
    const map = new Map<string, { sessionId: string; runId: string }>()
    for (const snap of Object.values(snapshotsByRunId)) {
      if (snap.status === 'running' && snap.sessionId !== currentSessionId) {
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

  // 按项目对会话进行分组
  const projectGroups = sessions.reduce((acc, session) => {
    const p = session.workspaceRoot
    if (!acc[p]) acc[p] = []
    acc[p].push(session)
    return acc
  }, {} as Record<string, typeof sessions>)

  // 控制每个项目的展开/收起状态 (默认都展开)
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(
    Object.keys(projectGroups).reduce((acc, p) => ({ ...acc, [p]: true }), {})
  )
  /** 每个项目会话列表是否已点「显示更多」（与项目文件夹开合独立） */
  const [expandedSessionLists, setExpandedSessionLists] = useState<Record<string, boolean>>({})

  const toggleProject = (p: string) => {
    setExpandedProjects(prev => ({ ...prev, [p]: !prev[p] }))
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
    <aside className="w-[260px] h-full flex flex-col bg-[rgba(250,249,245,0.85)] backdrop-blur-xl border-r border-border-warm shrink-0 select-none">
      {/* Top Header */}
      <div className="flex items-center justify-between p-4 border-b border-border-cream">
        <div className="flex items-center gap-2 cursor-pointer" title="Nova Agent">
          <NovaLogo size={20} />
          <span className="text-sm font-semibold text-text-primary tracking-wide font-serif">Nova Agent</span>
        </div>
      </div>

      <div className="px-3 py-3">
        <button 
          className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-full bg-white border border-border-warm shadow-sm hover:shadow-md hover:border-gray-300 transition-all text-sm font-medium text-text-primary group"
          onClick={() => createNewSession(currentProject || undefined)}
          title="新建对话"
        >
          <PlusIcon size={14} className="text-text-secondary group-hover:text-text-primary transition-colors" />
          <span>新对话</span>
        </button>
      </div>

      {/* Projects and Sessions */}
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <div className="flex items-center justify-between px-2 py-2 group cursor-pointer" onClick={selectProject}>
          <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">项目工作区</span>
          <div className="p-1 rounded hover:bg-gray-200/50 text-text-muted hover:text-text-primary transition-colors" title="添加新工作区">
            <PlusIcon size={12} />
          </div>
        </div>

        <div className="mt-1 space-y-1">
          {Object.entries(projectGroups).map(([projectPath, projectSessions]) => {
            const isExpanded = expandedProjects[projectPath] !== false
            // 选中会话在预览区之外时强制展开，避免选中项被藏住
            const selectedIndex = projectSessions.findIndex(s => s.id === currentSessionId)
            const selectedBeyondPreview = selectedIndex >= SIDEBAR_SESSION_PREVIEW_COUNT
            const userExpandedSessions = expandedSessionLists[projectPath] === true
            const isSessionListExpanded = userExpandedSessions || selectedBeyondPreview
            const visibleSessions =
              isSessionListExpanded || projectSessions.length <= SIDEBAR_SESSION_PREVIEW_COUNT
                ? projectSessions
                : projectSessions.slice(0, SIDEBAR_SESSION_PREVIEW_COUNT)
            const showMoreToggle = projectSessions.length > SIDEBAR_SESSION_PREVIEW_COUNT

            return (
              <div key={projectPath} className="flex flex-col">
                <div 
                  className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-gray-200/50 cursor-pointer group"
                  onClick={() => toggleProject(projectPath)}
                >
                  <div className="flex items-center gap-2 overflow-hidden">
                    <ChevronIcon 
                      size={12} 
                      direction={isExpanded ? 'down' : 'right'} 
                      style={{ transition: 'transform 0.2s' }}
                      className="text-text-muted shrink-0" 
                    />
                    <FolderIcon size={14} className="text-text-secondary shrink-0" />
                    <span className="text-sm text-text-primary truncate" title={projectPath}>
                      {getProjectName(projectPath)}
                    </span>
                  </div>
                  <div 
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-300/50 text-text-secondary transition-all"
                    title="在此项目下新建会话"
                    onClick={(e) => {
                      e.stopPropagation()
                      createNewSession(projectPath)
                    }}
                  >
                    <PlusIcon size={12} />
                  </div>
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
                        {visibleSessions.map(session => {
                          const isActive = session.id === currentSessionId
                          const isEditing = editingId === session.id
                          const displayTitle = getDisplayTitle(session)
                          const waitingBadge = waitingSessions.find(w => w.sessionId === session.id)
                          const showWaiting = !!waitingBadge && !isActive
                          const runningBadge = runningSessions.find(r => r.sessionId === session.id)
                          const showRunning = !!runningBadge && !isActive

                          return (
                            <div 
                              key={session.id}
                              onClick={() => !isEditing && selectSession(session.id)}
                              className={`group relative flex flex-col px-3 py-1.5 rounded-md cursor-pointer transition-colors ${
                                isActive ? 'bg-white shadow-sm border border-border-warm' : 'hover:bg-gray-200/50'
                              }`}
                              title={showWaiting ? '等待你处理' : undefined}
                            >
                              <div className="flex items-center justify-between gap-1 min-w-0">
                                {isEditing ? (
                                  <input
                                    ref={editInputRef}
                                    className="flex-1 min-w-0 text-sm px-1 py-0.5 rounded border border-border-warm text-text-primary bg-white outline-none focus:border-gray-400"
                                    value={editValue}
                                    maxLength={SESSION_TITLE_MAX_LENGTH}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onKeyDown={(e) => handleEditKeyDown(e, session.id)}
                                    onBlur={() => void submitRename(session.id)}
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                ) : (
                                  <span
                                    className={`text-sm truncate flex-1 min-w-0 ${isActive ? 'text-text-primary font-medium' : 'text-text-secondary'}`}
                                    title={displayTitle}
                                  >
                                    {displayTitle}
                                  </span>
                                )}
                                {showWaiting && (
                                  <div className="flex items-center gap-1 shrink-0">
                                    <span
                                      className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200"
                                      title="等待你处理"
                                    >
                                      等待你处理
                                    </span>
                                    <button
                                      type="button"
                                      className="text-[10px] px-1.5 py-0.5 rounded border border-border-warm text-text-secondary hover:bg-gray-100"
                                      title="停止此 XForge 运行"
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        void cancelExecution(waitingBadge?.runId)
                                      }}
                                    >
                                      停止
                                    </button>
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
                                    <button
                                      type="button"
                                      className="text-[10px] px-1.5 py-0.5 rounded border border-border-warm text-text-secondary hover:bg-gray-100"
                                      title="停止此会话的后台运行"
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        void cancelExecution(runningBadge?.runId)
                                      }}
                                    >
                                      停止
                                    </button>
                                  </div>
                                )}
                                <div className="flex items-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button
                                    className="p-1 rounded hover:bg-gray-300/50 text-text-muted hover:text-text-primary transition-all"
                                    title="重命名会话"
                                    onClick={(e) => startEditing(e, session)}
                                  >
                                    <EditIcon size={12} />
                                  </button>
                                  <button
                                    className="p-1 rounded hover:bg-gray-300/50 text-text-muted hover:text-red-500 transition-all"
                                    title="删除会话"
                                    onClick={(e) => handleDelete(e, session.id)}
                                  >
                                    <TrashIcon size={12} />
                                  </button>
                                </div>
                              </div>
                              <span className="text-[10px] text-text-muted mt-0.5">
                                {formatTime(session.updatedAt)}
                                {session.messageCount > 0 && ` · ${session.messageCount} 条对话`}
                              </span>
                            </div>
                          )
                        })}
                        {showMoreToggle && (
                          <button
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
                          >
                            {isSessionListExpanded ? '收起' : '显示更多'}
                          </button>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )
          })}
        </div>
      </div>

      {/* Bottom Footer */}
      <div className="p-3 border-t border-border-cream">
        <button 
          onClick={() => setConfigModalOpen(true)}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-200/50 transition-colors text-text-secondary hover:text-text-primary"
        >
          <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
            <SettingsIcon size={16} />
          </div>
          <span className="text-sm font-medium">设置</span>
        </button>
      </div>
    </aside>
  )
}
