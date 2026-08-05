import React, { useEffect, useState } from 'react'
import {
  MinimizeIcon,
  MaximizeIcon,
  RestoreIcon,
  CloseIcon,
  NovaLogo,
  PanelLeftIcon,
  PanelRightIcon
} from './Icons'
import { IconButton } from '@astryxdesign/core/IconButton'
import { useLayoutStore } from '../stores/useLayoutStore'
import './TitleBar.css'

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
      <div className="title-bar__right">
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
