/**
 * 面板顶栏的标签条：每个已打开视图一个标签，点击切换；悬停显示 ×，中键也可关闭。
 * 纯展示组件，标签数据与动作由调用方（useInspectorTabs）提供。
 */
import React from 'react'
import { CloseIcon } from '../../components/Icons'
import type { InspectorViewKey } from '../../stores/useLayoutStore'
import { VIEW_META } from './inspectorViewMeta'
import './InspectorTabStrip.css'

export interface InspectorTabStripProps {
  tabs: readonly InspectorViewKey[]
  activeTab: InspectorViewKey | null
  onActivate: (key: InspectorViewKey) => void
  onClose: (key: InspectorViewKey) => void
}

export const InspectorTabStrip: React.FC<InspectorTabStripProps> = ({ tabs, activeTab, onActivate, onClose }) => (
  <div className="inspector-tabs" role="tablist" aria-label="面板视图">
    {tabs.map(key => {
      const { name, icon } = VIEW_META[key]
      const active = key === activeTab
      return (
        <div
          key={key}
          role="presentation"
          className={`inspector-tab${active ? ' inspector-tab--active' : ''}`}
        >
          <button
            type="button"
            role="tab"
            aria-selected={active}
            title={name}
            className="inspector-tab__main"
            onClick={() => onActivate(key)}
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
