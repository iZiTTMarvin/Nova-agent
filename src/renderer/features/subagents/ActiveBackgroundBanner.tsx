/**
 * ActiveBackgroundBanner — 父会话常驻后台任务指示横条
 *
 * 当父会话有活跃的后台只读子任务时常驻展示，避免因父回合过程区折叠
 * 导致后台子任务不可见、用户失去感知。
 */
import React from 'react'
import { useSubagentProjectionStore, selectActiveBackgroundSubagentsByParentSessionId } from './projection'
import { useChatStore } from '../../stores/useChatStore'
import './ActiveBackgroundBanner.css'

export interface ActiveBackgroundBannerProps {
  parentSessionId: string | null
}

export const ActiveBackgroundBanner: React.FC<ActiveBackgroundBannerProps> = ({ parentSessionId }) => {
  const activeSubagents = useSubagentProjectionStore((state) =>
    selectActiveBackgroundSubagentsByParentSessionId(state, parentSessionId)
  )

  if (activeSubagents.length === 0) {
    return null
  }

  const primary = activeSubagents[0]
  const count = activeSubagents.length
  const taskText = primary.taskLabel || primary.profile.name
  const bannerText =
    count > 1
      ? `${count} 个后台子任务运行中 · ${primary.profile.name} 等`
      : `后台子任务运行中 · ${primary.profile.name}${primary.taskLabel && primary.taskLabel !== primary.profile.name ? ` (${primary.taskLabel})` : ''}`

  const handleOpenSession = (childSessionId: string) => {
    void useChatStore.getState().selectSession(childSessionId)
  }

  return (
    <aside
      className="active-background-banner"
      role="status"
      aria-label={bannerText}
    >
      <div className="active-background-banner__left">
        <span className="active-background-banner__dot" aria-hidden="true" />
        <span className="active-background-banner__text" title={taskText}>
          {bannerText}
        </span>
      </div>
      <div className="active-background-banner__actions">
        <button
          type="button"
          className="active-background-banner__btn"
          onClick={() => handleOpenSession(primary.childSessionId)}
        >
          查看子会话 ↗
        </button>
      </div>
    </aside>
  )
}
