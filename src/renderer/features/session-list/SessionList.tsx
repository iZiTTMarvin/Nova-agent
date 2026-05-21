import React from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { TrashIcon, PlusIcon } from '../../components/Icons'
import './SessionList.css'

export const SessionList: React.FC = () => {
  const sessions = useAppStore(state => state.sessions)
  const currentSessionId = useAppStore(state => state.currentSessionId)
  const currentProject = useAppStore(state => state.currentProject)
  const selectSession = useAppStore(state => state.selectSession)
  const deleteSession = useAppStore(state => state.deleteSession)
  const createNewSession = useAppStore(state => state.createNewSession)

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
    if (window.confirm('确定要删除这个会话吗？所有相关的历史记录和备份都将被永久删除。')) {
      deleteSession(sessionId)
    }
  }

  return (
    <div className="session-list-container">
      <div className="session-list-header">
        <h3 className="session-list-title">历史会话</h3>
        {currentProject && (
          <button 
            className="session-list__new-btn"
            onClick={createNewSession}
            title="新建会话"
          >
            <PlusIcon size={12} />
            <span>新建</span>
          </button>
        )}
      </div>

      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="session-list__empty">暂无历史会话</div>
        ) : (
          sessions.map((session) => {
            const isActive = session.id === currentSessionId
            return (
              <div 
                key={session.id}
                className={`session-item ${isActive ? 'session-item--active' : ''}`}
                onClick={() => selectSession(session.id)}
              >
                <div className="session-item__info">
                  <div className="session-item__project" title={session.workspaceRoot}>
                    {getProjectName(session.workspaceRoot)}
                  </div>
                  <div className="session-item__meta">
                    <span className="session-item__time">{formatTime(session.updatedAt)}</span>
                    <span className="session-item__count">{session.messageCount} 条对话</span>
                  </div>
                </div>
                <button 
                  className="session-item__delete-btn"
                  onClick={(e) => handleDelete(e, session.id)}
                  title="删除会话"
                >
                  <TrashIcon size={13} />
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
