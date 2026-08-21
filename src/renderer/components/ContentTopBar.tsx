import React, { useEffect, useState } from 'react'
import {
  MinimizeIcon,
  MaximizeIcon,
  RestoreIcon,
  CloseIcon,
  PanelLeftIcon,
  PanelRightIcon
} from './Icons'
import { IconButton } from '@astryxdesign/core/IconButton'
import { useLayoutStore } from '../stores/useLayoutStore'
import { useChatStore } from '../stores/useChatStore'
import { SessionBreadcrumb } from '../features/chat/SessionBreadcrumb'
import './ContentTopBar.css'

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

/** 窗口控制按钮组：最小化 / 最大化或还原 / 关闭（Windows 风格，固定在内容区顶行右侧） */
const WindowControls: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    // 获取初始最大化状态
    window.api.invoke('window-is-maximized').then(setIsMaximized).catch(console.error)

    // 监听主进程的窗口最大化事件
    const unsub = window.api.on('window:maximize-change', (data) => {
      setIsMaximized(data.isMaximized)
    })

    return unsub
  }, [])

  return (
    <>
      <IconButton
        label="最小化"
        icon={<MinimizeIcon size={14} />}
        variant="ghost"
        size="sm"
        className="content-topbar__btn content-topbar__btn--minimize"
        onClick={() => window.api.invoke('window-minimize').catch(console.error)}
        tooltip="最小化"
      />
      <IconButton
        label={isMaximized ? '向下还原' : '最大化'}
        icon={isMaximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
        variant="ghost"
        size="sm"
        className="content-topbar__btn content-topbar__btn--maximize"
        onClick={() => window.api.invoke('window-maximize').catch(console.error)}
        tooltip={isMaximized ? '向下还原' : '最大化'}
      />
      <IconButton
        label="关闭"
        icon={<CloseIcon size={14} />}
        variant="ghost"
        size="sm"
        className="content-topbar__btn content-topbar__btn--close"
        onClick={() => window.api.invoke('window-close').catch(console.error)}
        tooltip="关闭"
      />
    </>
  )
}

/** 当前会话 ⋯ 菜单：置顶/取消置顶、删除。仅普通会话可用（子会话由父会话管理）。 */
const SessionMoreMenu: React.FC = () => {
  const sessions = useChatStore(state => state.sessions)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const deleteSession = useChatStore(state => state.deleteSession)
  const setSessionPinned = useChatStore(state => state.setSessionPinned)
  const [open, setOpen] = useState(false)
  useDismissOnOutsideInteraction(open, () => setOpen(false), '.content-topbar__session-menu')

  const currentSession = sessions.find(s => s.id === currentSessionId)
  if (!currentSession || currentSession.kind !== 'primary') return null

  const handleDelete = async () => {
    setOpen(false)
    const response = await window.api.invoke('dialog:confirm', {
      title: '删除会话',
      message: '确定要删除这个会话吗？',
      detail: '删除后无法恢复。'
    })
    if (response !== 1) return
    try {
      await deleteSession(currentSession.id)
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

  return (
    <div className="content-topbar__session-menu">
      <IconButton
        label="当前会话操作"
        icon={<span className="content-topbar__menu-ellipsis" aria-hidden>⋯</span>}
        variant="ghost"
        size="sm"
        className="content-topbar__btn"
        tooltip="当前会话操作"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(v => !v)}
      />
      {open && (
        <div className="content-topbar__menu-panel" role="menu">
          <button
            type="button"
            role="menuitem"
            className="content-topbar__menu-item"
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
            className="content-topbar__menu-item content-topbar__menu-item--danger"
            onClick={() => void handleDelete()}
          >
            删除
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * 内容区顶行（右栏自己的顶栏）：
 * 左侧贴分界线放会话路径面包屑；右侧依次是 inspector 开关、当前会话 ⋯ 菜单、窗口控制。
 * 左右两栏各自通顶、中间由 AppShell 分界，不再有贯穿整个窗口的顶栏。
 */
export const ContentTopBar: React.FC = () => {
  const sidebarCollapsed = useLayoutStore(state => state.sidebarCollapsed)
  const inspectorOpen = useLayoutStore(state => state.inspectorOpen)

  return (
    <div className="content-topbar">
      <div className="content-topbar__drag-area" />
      <div className="content-topbar__left">
        {/* 侧栏折叠时其顶行随侧栏一起隐藏，这里补一个展开入口 */}
        {sidebarCollapsed && (
          <IconButton
            label="展开会话导航"
            icon={<PanelLeftIcon size={16} />}
            variant="ghost"
            size="sm"
            className="content-topbar__btn content-topbar__btn--sidebar"
            onClick={() => useLayoutStore.getState().toggleSidebar()}
            tooltip="展开会话导航"
          />
        )}
        <SessionBreadcrumb />
      </div>
      <div className="content-topbar__right">
        <IconButton
          label="审查与文件面板"
          icon={<PanelRightIcon size={16} />}
          variant="ghost"
          size="sm"
          className={`content-topbar__btn${inspectorOpen ? ' content-topbar__btn--active' : ''}`}
          onClick={() => useLayoutStore.getState().toggleInspector()}
          tooltip="审查与文件面板"
        />
        <SessionMoreMenu />
        <WindowControls />
      </div>
    </div>
  )
}
