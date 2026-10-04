/**
 * Inspector 首页启动器：面板未打开任何视图时，以「打开 X」卡片列出全部真实视图；
 * 头部 + 菜单复用同一份动作表。卡片只挂真实存在的视图与真实快捷键，
 * 副行优先显示快捷键，没有快捷键时显示说明（说明同时作为悬浮提示）。
 */
import React, { type ReactNode } from 'react'
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu'
import { FolderIcon, GlobeIcon, UserCheckIcon, PlanIcon, PlusIcon } from '../../components/Icons'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import './InspectorLauncher.css'

export interface LauncherItem {
  key: string
  icon: ReactNode
  title: string
  desc: string
  kbd?: string
  open: () => void
}

export const buildLauncherItems = (isLearn: boolean): LauncherItem[] => {
  const layout = () => useLayoutStore.getState()
  const files: LauncherItem = {
    key: 'files',
    icon: <FolderIcon size={16} />,
    title: '打开工作区文件',
    desc: '浏览当前工作区的全部文件',
    open: () => {
      if (isLearn) layout().setLearnInspectorTab('files')
      else layout().setInspectorTab('files')
    }
  }
  const browser: LauncherItem = {
    key: 'browser',
    icon: <GlobeIcon size={16} />,
    title: '打开内置浏览器',
    desc: '在会话工作区打开网页',
    kbd: 'Ctrl Alt B',
    open: () => layout().openBrowserPane(isLearn)
  }
  if (isLearn) {
    return [
      {
        key: 'outline',
        icon: <PlanIcon size={16} />,
        title: '打开大纲',
        desc: '查看学习会话的知识大纲',
        open: () => layout().openOutline()
      },
      files,
      browser
    ]
  }
  return [
    {
      key: 'review',
      icon: <UserCheckIcon size={16} />,
      title: '打开审阅',
      desc: '查看本轮改动的 diff 与评审',
      open: () => layout().setInspectorTab('review')
    },
    files,
    browser
  ]
}

export const InspectorLauncher: React.FC = () => {
  const isLearn = useWorkspaceStore(s => s.currentMode === 'learn' && s.currentSessionId !== null)
  const items = buildLauncherItems(isLearn)

  return (
    <div className="inspector-launcher">
      {items.map(item => (
        <button
          key={item.key}
          type="button"
          className="inspector-launcher__card"
          title={item.desc}
          onClick={item.open}
        >
          <span className="inspector-launcher__ico" aria-hidden>{item.icon}</span>
          <span className="inspector-launcher__txt">
            <b>{item.title}</b>
            <i>{item.kbd ?? item.desc}</i>
          </span>
        </button>
      ))}
    </div>
  )
}

/** 视图激活时头部 + 菜单：与首页卡片同一份动作表，随时互切 */
export const InspectorOpenMenu: React.FC = () => {
  const isLearn = useWorkspaceStore(s => s.currentMode === 'learn' && s.currentSessionId !== null)
  return (
    <DropdownMenu
      button={{
        label: '打开视图',
        icon: <PlusIcon size={14} />,
        variant: 'ghost',
        size: 'sm',
        isIconOnly: true,
        className: 'inspector-icon-btn',
        tooltip: '打开视图'
      }}
    >
      {buildLauncherItems(isLearn).map(item => (
        <DropdownMenuItem key={item.key} label={item.title} onClick={item.open} />
      ))}
    </DropdownMenu>
  )
}
