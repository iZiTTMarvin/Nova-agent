import React, { useState } from 'react'
import { useAppStore } from '../stores/useAppStore'
import { NovaLogo, FolderIcon, SettingsIcon, PlusIcon, ChevronIcon, TrashIcon } from './Icons'
import { motion, AnimatePresence } from 'framer-motion'

export const Sidebar: React.FC = () => {
  const sessions = useAppStore(state => state.sessions)
  const currentSessionId = useAppStore(state => state.currentSessionId)
  const currentProject = useAppStore(state => state.currentProject)
  const selectProject = useAppStore(state => state.selectProject)
  const createNewSession = useAppStore(state => state.createNewSession)
  const selectSession = useAppStore(state => state.selectSession)
  const setConfigModalOpen = useAppStore(state => state.setConfigModalOpen)
  const deleteSession = useAppStore(state => state.deleteSession)

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

  const toggleProject = (p: string) => {
    setExpandedProjects(prev => ({ ...prev, [p]: !prev[p] }))
  }

  const getProjectName = (pathStr: string) => {
    const parts = pathStr.split(/[\\/]/)
    return parts[parts.length - 1] || pathStr
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  const handleDelete = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    if (window.confirm('确定要删除这个会话吗？')) {
      deleteSession(sessionId)
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
                        {projectSessions.map(session => {
                          const isActive = session.id === currentSessionId
                          return (
                            <div 
                              key={session.id}
                              onClick={() => selectSession(session.id)}
                              className={`group relative flex flex-col px-3 py-1.5 rounded-md cursor-pointer transition-colors ${
                                isActive ? 'bg-white shadow-sm border border-border-warm' : 'hover:bg-gray-200/50'
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <span className={`text-sm truncate ${isActive ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>
                                  {session.messageCount > 0 ? `${session.messageCount} 条对话` : '新对话'}
                                </span>
                                <button
                                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-300/50 text-text-muted hover:text-red-500 transition-all"
                                  onClick={(e) => handleDelete(e, session.id)}
                                >
                                  <TrashIcon size={12} />
                                </button>
                              </div>
                              <span className="text-[10px] text-text-muted mt-0.5">
                                {formatTime(session.updatedAt)}
                              </span>
                            </div>
                          )
                        })}
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
