import React, { useEffect, useState } from 'react'
import { MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon, NovaLogo } from './Icons'
import './TitleBar.css'

export const TitleBar: React.FC = () => {
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
        <NovaLogo size={14} className="title-bar__logo" />
        <span className="title-bar__title">Nova Agent</span>
      </div>
      <div className="title-bar__right">
        <button 
          className="title-bar__btn title-bar__btn--minimize" 
          onClick={handleMinimize}
          title="最小化"
        >
          <MinimizeIcon size={12} />
        </button>
        <button 
          className="title-bar__btn title-bar__btn--maximize" 
          onClick={handleMaximize}
          title={isMaximized ? "向下还原" : "最大化"}
        >
          {isMaximized ? <RestoreIcon size={12} /> : <MaximizeIcon size={12} />}
        </button>
        <button 
          className="title-bar__btn title-bar__btn--close" 
          onClick={handleClose}
          title="关闭"
        >
          <CloseIcon size={12} />
        </button>
      </div>
    </div>
  )
}
