/**
 * 右侧面板开合按钮：按当前表面（学习 / 开发）切换对应那组面板状态。
 * 全局只有一个实例，钉在玻璃体右上角；面板开合时它保持原位可见，
 * 打开态叠加 inspector-icon-btn--active 高亮。
 */
import React from 'react'
import { IconButton } from '@astryxdesign/core/IconButton'
import { PanelRightIcon } from '../../components/Icons'
import { selectInspectorOpenForSurface, useLayoutStore } from '../../stores/useLayoutStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'

export const InspectorToggleButton: React.FC<{ className?: string }> = ({ className }) => {
  const isLearnSurface = useWorkspaceStore(s => s.currentMode === 'learn' && s.currentSessionId !== null)
  const open = useLayoutStore(s => selectInspectorOpenForSurface(s, isLearnSurface))
  const label = isLearnSurface ? '大纲、文件与浏览面板' : '审阅、文件与浏览面板'
  const classes = [
    'inspector-icon-btn',
    open ? 'inspector-icon-btn--active' : '',
    className ?? ''
  ].filter(Boolean).join(' ')

  return (
    <IconButton
      label={label}
      icon={<PanelRightIcon size={16} />}
      variant="ghost"
      size="sm"
      className={classes}
      aria-expanded={open}
      onClick={() => {
        const layout = useLayoutStore.getState()
        if (isLearnSurface) layout.toggleLearnInspector()
        else layout.toggleInspector()
      }}
      tooltip={label}
    />
  )
}
