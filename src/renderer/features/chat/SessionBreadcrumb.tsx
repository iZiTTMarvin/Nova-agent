import React from 'react'
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu'
import { useChatStore } from '../../stores/useChatStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { SESSION_PLACEHOLDER_TITLE } from '../../../shared/session/title'
import { listBreadcrumbSessions, resolveSidebarActiveSessionId } from '../subagents/sidebarSessions'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { FolderIcon, ChevronIcon, CheckIcon } from '../../components/Icons'
import { formatSettingsRelativeTime } from '../settings/formatDateTime'

/** 工作区路径取末段作为展示名（与侧边栏项目分组同名规则） */
function projectDisplayName(pathStr: string): string {
  const parts = pathStr.split(/[\\/]/)
  return parts[parts.length - 1] || pathStr
}

/**
 * 内容区顶行的会话路径面包屑：工作区 / 会话标题（无边框纯文字路径样式）。
 * 点击展开当前工作区下的会话列表用于快速切换；焦点在子代理会话时显示其父会话，
 * 与侧边栏高亮规则一致。无工作区或无会话时不占位。
 */
export const SessionBreadcrumb: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const sessions = useChatStore(state => state.sessions)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const selectSession = useChatStore(state => state.selectSession)
  const currentMode = useWorkspaceStore(state => state.currentMode)

  const displaySessionId = resolveSidebarActiveSessionId(sessions, currentSessionId)
  const displaySession = sessions.find(s => s.id === displaySessionId)
  if (!currentProject || !displaySession) return null

  const projectSessions = listBreadcrumbSessions(sessions, currentProject, currentMode === 'learn' ? 'learn' : 'dev')
  const currentTitle = displaySession.title || SESSION_PLACEHOLDER_TITLE
  const triggerLabel = `${projectDisplayName(currentProject)} / ${currentTitle}`

  return (
    <div className="chat-session-breadcrumb">
      <DropdownMenu
        className="chat-session-breadcrumb__panel"
        button={{
          label: triggerLabel,
          icon: <FolderIcon size={16} className="chat-session-breadcrumb__folder" />,
          variant: 'ghost',
          size: 'sm',
          className: 'chat-session-breadcrumb__trigger',
          endContent: <ChevronIcon size={14} direction="down" className="chat-session-breadcrumb__chevron" />,
          children: (
            <>
              <span className="chat-session-breadcrumb__project">{projectDisplayName(currentProject)}</span>
              <span className="chat-session-breadcrumb__sep" aria-hidden>/</span>
              <span className="chat-session-breadcrumb__session" title={currentTitle}>
                {currentTitle}
              </span>
            </>
          )
        }}
      >
        {projectSessions.map(s => {
          const title = s.title || SESSION_PLACEHOLDER_TITLE
          return (
            <DropdownMenuItem
              key={s.id}
              className="chat-session-breadcrumb__item"
              label={(
                <span className="chat-session-breadcrumb__item-label" title={title}>
                  {title}
                </span>
              )}
              description={`更新时间：${formatSettingsRelativeTime(s.updatedAt)}`}
              endContent={s.id === displaySessionId ? <CheckIcon size={12} /> : undefined}
              onClick={() => {
                void selectSession(s.id)
              }}
            />
          )
        })}
      </DropdownMenu>
    </div>
  )
}
