import React, { useEffect, useState } from 'react'
import { useChatStore } from '../../stores/useChatStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { SESSION_PLACEHOLDER_TITLE } from '../../../shared/session/title'
import { listSidebarRootSessions, resolveSidebarActiveSessionId } from '../subagents/sidebarSessions'
import { FolderIcon, ChevronIcon, CheckIcon } from '../../components/Icons'

/** 工作区路径取末段作为展示名（与侧边栏项目分组同名规则） */
function projectDisplayName(pathStr: string): string {
  const parts = pathStr.split(/[\\/]/)
  return parts[parts.length - 1] || pathStr
}

/**
 * 对话区顶部的会话路径面包屑：工作区 / 会话标题。
 * 点击展开当前工作区下的会话列表用于快速切换；焦点在子代理会话时显示其父会话，
 * 与侧边栏高亮规则一致。无工作区或无会话时不占位。
 */
export const SessionBreadcrumb: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const sessions = useChatStore(state => state.sessions)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const selectSession = useChatStore(state => state.selectSession)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.chat-session-breadcrumb')) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const displaySessionId = resolveSidebarActiveSessionId(sessions, currentSessionId)
  const displaySession = sessions.find(s => s.id === displaySessionId)
  if (!currentProject || !displaySession) return null

  const projectSessions = listSidebarRootSessions(sessions).filter(
    s => s.workspaceRoot === currentProject
  )

  return (
    <div className="chat-session-breadcrumb">
      <button
        type="button"
        className="chat-session-breadcrumb__trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(v => !v)}
      >
        <FolderIcon size={13} className="chat-session-breadcrumb__folder" />
        <span className="chat-session-breadcrumb__project">{projectDisplayName(currentProject)}</span>
        <span className="chat-session-breadcrumb__sep" aria-hidden>/</span>
        <span className="chat-session-breadcrumb__session">
          {displaySession.title || SESSION_PLACEHOLDER_TITLE}
        </span>
        <ChevronIcon size={10} direction="down" className="chat-session-breadcrumb__chevron" />
      </button>
      {open && (
        <div className="chat-session-breadcrumb__panel" role="menu">
          {projectSessions.map(s => (
            <button
              key={s.id}
              type="button"
              role="menuitem"
              className="chat-session-breadcrumb__item"
              onClick={() => {
                setOpen(false)
                void selectSession(s.id)
              }}
            >
              <span className="chat-session-breadcrumb__item-label">
                {s.title || SESSION_PLACEHOLDER_TITLE}
              </span>
              {s.id === displaySessionId && <CheckIcon size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
