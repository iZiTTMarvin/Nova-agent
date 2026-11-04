/**
 * 面板顶栏的标签条：每个已打开视图一个标签，点击切换；悬停显示 ×，中键也可关闭。
 * 键盘按 roving tabindex：只有选中标签进入 Tab 序列，左右方向键与 Home/End 切换。
 * 纯展示组件，标签数据与动作由调用方（useInspectorTabs）提供。
 */
import React, { useRef } from 'react'
import { CloseIcon } from '../../components/Icons'
import type { InspectorViewKey } from '../../stores/useLayoutStore'
import { VIEW_META } from './inspectorViewMeta'
import './InspectorTabStrip.css'

export function inspectorTabId(key: InspectorViewKey): string {
  return `inspector-tab-${key}`
}

export function inspectorTabPanelId(key: InspectorViewKey): string {
  return `inspector-tabpanel-${key}`
}

export interface InspectorTabStripProps {
  tabs: readonly InspectorViewKey[]
  activeTab: InspectorViewKey | null
  onActivate: (key: InspectorViewKey) => void
  onClose: (key: InspectorViewKey) => void
}

export const InspectorTabStrip: React.FC<InspectorTabStripProps> = ({ tabs, activeTab, onActivate, onClose }) => {
  const tabRefs = useRef(new Map<InspectorViewKey, HTMLButtonElement>())
  const focusKey = activeTab !== null && tabs.includes(activeTab) ? activeTab : tabs[0]

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1
    const nextIndex =
      e.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
        : e.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
          : e.key === 'Home' ? 0
            : e.key === 'End' ? last
              : null
    if (nextIndex === null) return
    e.preventDefault()
    const nextKey = tabs[nextIndex]
    onActivate(nextKey)
    tabRefs.current.get(nextKey)?.focus()
  }

  return (
    <div className="inspector-tabs" role="tablist" aria-label="面板视图">
      {tabs.map((key, index) => {
        const { name, icon } = VIEW_META[key]
        const active = key === activeTab
        return (
          <div
            key={key}
            role="presentation"
            className={`inspector-tab${active ? ' inspector-tab--active' : ''}`}
          >
            <button
              ref={el => {
                if (el) tabRefs.current.set(key, el)
                else tabRefs.current.delete(key)
              }}
              type="button"
              role="tab"
              id={inspectorTabId(key)}
              aria-selected={active}
              aria-controls={inspectorTabPanelId(key)}
              tabIndex={key === focusKey ? 0 : -1}
              title={name}
              data-testid={`inspector-tab-${key}`}
              className="inspector-tab__main"
              onClick={() => onActivate(key)}
              onKeyDown={e => onTabKeyDown(e, index)}
              onAuxClick={e => {
                if (e.button === 1) onClose(key)
              }}
            >
              <span className="inspector-tab__icon" aria-hidden>{icon}</span>
              <span className="inspector-tab__name">{name}</span>
            </button>
            <button
              type="button"
              className="inspector-tab__close"
              aria-label={`关闭${name}`}
              onClick={() => onClose(key)}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
