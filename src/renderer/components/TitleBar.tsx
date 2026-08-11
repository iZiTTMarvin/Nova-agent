import React, { useEffect, useState } from 'react'
import {
  MinimizeIcon,
  MaximizeIcon,
  RestoreIcon,
  CloseIcon,
  NovaLogo,
  PanelLeftIcon,
  PanelRightIcon,
  ChevronIcon,
  CheckIcon
} from './Icons'
import { IconButton } from '@astryxdesign/core/IconButton'
import { useLayoutStore } from '../stores/useLayoutStore'
import { useChatStore } from '../stores/useChatStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import { SESSION_PLACEHOLDER_TITLE } from '../../shared/session/title'
import { listSidebarRootSessions, resolveSidebarActiveSessionId } from '../features/subagents/sidebarSessions'
import './TitleBar.css'

/** 工作区路径取末段作为展示名（与侧边栏项目分组同名规则） */
function projectDisplayName(pathStr: string): string {
  const parts = pathStr.split(/[\\/]/)
  return parts[parts.length - 1] || pathStr
}

/** 菜单打开期间：点击外部或 Escape 关闭（与侧边栏会话菜单同一交互约定） */
function useDismissOnOutsideInteraction(open: boolean, onDismiss: () => void, excludeSelector: string): void {
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(excludeSelector)) return
      onDismiss()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss()
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onDismiss, excludeSelector])
}

/**
 * 中部面包屑：当前工作区 / 当前会话标题。
 * 点击展开当前工作区下的会话列表用于快速切换；焦点在子代理会话时显示其父会话，
 * 与侧边栏高亮规则一致。
 */
const TitleBarBreadcrumb: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const sessions = useChatStore(state => state.sessions)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const selectSession = useChatStore(state => state.selectSession)
  const [open, setOpen] = useState(false)
  useDismissOnOutsideInteraction(open, () => setOpen(false), '.title-bar__center')

  const displaySessionId = resolveSidebarActiveSessionId(sessions, currentSessionId)
  const displaySession = sessions.find(s => s.id === displaySessionId)
  if (!currentProject || !displaySession) return null

  const projectSessions = listSidebarRootSessions(sessions).filter(
    s => s.workspaceRoot === currentProject
  )

  return (
    <div className="title-bar__center">
      <button
        type="button"
        className="title-bar-breadcrumb"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(v => !v)}
      >
        <span className="title-bar-breadcrumb__project">{projectDisplayName(currentProject)}</span>
        <span className="title-bar-breadcrumb__sep" aria-hidden>/</span>
        <span className="title-bar-breadcrumb__session">
          {displaySession.title || SESSION_PLACEHOLDER_TITLE}
        </span>
        <ChevronIcon size={10} direction="down" className="title-bar-breadcrumb__chevron" />
      </button>
      {open && (
        <div className="title-bar-breadcrumb__panel" role="menu">
          {projectSessions.map(s => (
            <button
              key={s.id}
              type="button"
              role="menuitem"
              className="title-bar-breadcrumb__item"
              onClick={() => {
                setOpen(false)
                void selectSession(s.id)
              }}
            >
              <span className="title-bar-breadcrumb__item-label">
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

/** 右侧当前会话 ⋯ 菜单：置顶/取消置顶、删除。仅普通会话可用（子会话由父会话管理）。 */
const TitleBarSessionMenu: React.FC = () => {
  const sessions = useChatStore(state => state.sessions)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const deleteSession = useChatStore(state => state.deleteSession)
  const setSessionPinned = useChatStore(state => state.setSessionPinned)
  const [open, setOpen] = useState(false)
  useDismissOnOutsideInteraction(open, () => setOpen(false), '.title-bar-session-menu')

  const currentSession = sessions.find(s => s.id === currentSessionId)
  if (!currentSession || currentSession.kind !== 'primary') return null

  const handleDelete = async () => {
    setOpen(false)
    const response = await window.api.invoke('dialog:confirm', {
      title: '删除会话',
      message: '确定要删除这个会话吗？',
      detail: '删除后无法恢复。'
    })
    if (response === 1) {
      deleteSession(currentSession.id)
    }
  }

  return (
    <div className="title-bar-session-menu">
      <IconButton
        label="当前会话操作"
        icon={<span className="title-bar-session-menu__ellipsis" aria-hidden>⋯</span>}
        variant="ghost"
        size="sm"
        className="title-bar__btn title-bar__btn--layout"
        tooltip="当前会话操作"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(v => !v)}
      />
      {open && (
        <div className="title-bar-session-menu__panel" role="menu">
          <button
            type="button"
            role="menuitem"
            className="title-bar-session-menu__item"
            onClick={() => {
              setOpen(false)
              void setSessionPinned(currentSession.id, !currentSession.pinned)
            }}
          >
            {currentSession.pinned ? '取消置顶' : '置顶'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="title-bar-session-menu__item title-bar-session-menu__item--danger"
            onClick={() => void handleDelete()}
          >
            删除
          </button>
        </div>
      )}
    </div>
  )
}

export const TitleBar: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState(false)
  const sidebarCollapsed = useLayoutStore(state => state.sidebarCollapsed)
  const inspectorOpen = useLayoutStore(state => state.inspectorOpen)

  useEffect(() => {
    // 获取初始最大化状态
    window.api.invoke('window-is-maximized').then(setIsMaximized).catch(console.error)

    // 监听主进程的窗口最大化事件
    const unsub = window.api.on('window:maximize-change', (data) => {
      setIsMaximized(data.isMaximized)
    })

    return unsub
  }, [])

  const handleMinimize = () => {
    window.api.invoke('window-minimize').catch(console.error)
  }

  const handleMaximize = () => {
    window.api.invoke('window-maximize').catch(console.error)
  }

  const handleClose = () => {
    window.api.invoke('window-close').catch(console.error)
  }

  return (
    <div className="title-bar">
      <div className="title-bar__drag-area" />
      <div className="title-bar__left">
        <IconButton
          label="折叠/展开会话导航"
          icon={<PanelLeftIcon size={12} />}
          variant="ghost"
          size="sm"
          className={`title-bar__btn title-bar__btn--layout${sidebarCollapsed ? ' title-bar__btn--layout-active' : ''}`}
          onClick={() => useLayoutStore.getState().toggleSidebar()}
          tooltip="折叠/展开会话导航"
        />
        <NovaLogo size={14} className="title-bar__logo" />
        <span className="title-bar__title">Nova Agent</span>
      </div>
      <TitleBarBreadcrumb />
      <div className="title-bar__right">
        <TitleBarSessionMenu />
        <IconButton
          label="审查与文件面板"
          icon={<PanelRightIcon size={12} />}
          variant="ghost"
          size="sm"
          className={`title-bar__btn title-bar__btn--layout${inspectorOpen ? ' title-bar__btn--layout-active' : ''}`}
          onClick={() => useLayoutStore.getState().toggleInspector()}
          tooltip="审查与文件面板"
        />
        <IconButton
          label="最小化"
          icon={<MinimizeIcon size={12} />}
          variant="ghost"
          size="sm"
          className="title-bar__btn title-bar__btn--minimize"
          onClick={handleMinimize}
          tooltip="最小化"
        />
        <IconButton
          label={isMaximized ? '向下还原' : '最大化'}
          icon={isMaximized ? <RestoreIcon size={12} /> : <MaximizeIcon size={12} />}
          variant="ghost"
          size="sm"
          className="title-bar__btn title-bar__btn--maximize"
          onClick={handleMaximize}
          tooltip={isMaximized ? '向下还原' : '最大化'}
        />
        <IconButton
          label="关闭"
          icon={<CloseIcon size={12} />}
          variant="ghost"
          size="sm"
          className="title-bar__btn title-bar__btn--close"
          onClick={handleClose}
          tooltip="关闭"
        />
      </div>
    </div>
  )
}
