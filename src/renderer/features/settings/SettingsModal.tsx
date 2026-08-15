/**
 * SettingsModal — 全屏设置壳层
 * 左侧分组导航（偏好 / 能力 / 系统）+ 右侧浮动内容板；
 * 内容板顶部承载当前板块的标题与描述，各面板不再自带页头。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Dialog } from '@astryxdesign/core/Dialog'
import { SideNav, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { rulesI18n, skillsI18n, subagentsI18n } from '../skills/i18n'
import { GeneralSettingsPanel } from './GeneralSettingsPanel'
import { LlmSettingsPanel } from './LlmSettingsPanel'
import { RulesSettingsPanel } from './RulesSettingsPanel'
import { SkillsSettingsPanel } from './SkillsSettingsPanel'
import { SubagentsSettingsPanel } from './SubagentsSettingsPanel'
import { PermissionsSettingsPanel } from './PermissionsSettingsPanel'
import { StorageSettingsPanel } from './StorageSettingsPanel'
import { WebSearchSettingsPanel } from './WebSearchSettingsPanel'
import { MemorySettingsPanel } from './MemorySettingsPanel'
import './SettingsModal.css'

const NAV_STORAGE_KEY = 'nova-settings-nav'

export type SettingsSection =
  | 'general'
  | 'llm'
  | 'websearch'
  | 'memory'
  | 'rules'
  | 'skills'
  | 'subagents'
  | 'permissions'
  | 'storage'

const SECTION_IDS: SettingsSection[] = [
  'general',
  'llm',
  'websearch',
  'memory',
  'rules',
  'skills',
  'subagents',
  'permissions',
  'storage'
]

interface NavItemMeta {
  id: SettingsSection
  label: string
  description: string
}

const NAV_GROUPS: { title: string; items: NavItemMeta[] }[] = [
  {
    title: '偏好',
    items: [
      { id: 'general', label: '通用', description: '应用级偏好设置，重启后仍然生效。' }
    ]
  },
  {
    title: '能力',
    items: [
      {
        id: 'llm',
        label: 'LLM 配置',
        description: '按服务商管理 API Key 与模型，可在对话框底部快速切换。'
      },
      {
        id: 'websearch',
        label: '联网搜索',
        description:
          '无需配置 API Key 也可通过 Bing / DuckDuckGo 联网搜索。填写 Tavily API Key 可在爬虫失败时作为质量增强兜底。'
      },
      {
        id: 'memory',
        label: '记忆',
        description: '查看与编辑当前工作区的跨会话记忆文件（按工作区哈希隔离）。'
      },
      { id: 'rules', label: '规则', description: rulesI18n.panelDesc },
      { id: 'skills', label: '技能', description: skillsI18n.panelDesc },
      { id: 'subagents', label: '子代理', description: subagentsI18n.panelDesc }
    ]
  },
  {
    title: '系统',
    items: [
      {
        id: 'permissions',
        label: '权限',
        description: '管理工具调用的持久化授权规则。项目级规则只对当前打开的项目生效。'
      },
      {
        id: 'storage',
        label: '存储',
        description: '查看会话磁盘占用，并清理 checkpoint 快照或彻底删除不再需要的会话。'
      }
    ]
  }
]

function findNavMeta(id: SettingsSection): NavItemMeta {
  for (const group of NAV_GROUPS) {
    const hit = group.items.find(item => item.id === id)
    if (hit) return hit
  }
  return NAV_GROUPS[0].items[0]
}

function readStoredSection(): SettingsSection {
  try {
    const raw = sessionStorage.getItem(NAV_STORAGE_KEY)
    if (raw && (SECTION_IDS as string[]).includes(raw)) {
      return raw as SettingsSection
    }
  } catch {
    // sessionStorage 不可用时忽略
  }
  return 'general'
}

export const SettingsModal: React.FC = () => {
  const isOpen = useSettingsStore(state => state.isConfigModalOpen)
  const setConfigModalOpen = useSettingsStore(state => state.setConfigModalOpen)
  const [section, setSection] = useState<SettingsSection>(readStoredSection)
  const navRefs = useRef<Partial<Record<SettingsSection, HTMLElement | null>>>({})

  useEffect(() => {
    if (isOpen) {
      setSection(readStoredSection())
    }
  }, [isOpen])

  const selectSection = (id: SettingsSection) => {
    setSection(id)
    try {
      sessionStorage.setItem(NAV_STORAGE_KEY, id)
    } catch {
      // 忽略
    }
    navRefs.current[id]?.focus()
  }

  if (!isOpen) return null

  const active = findNavMeta(section)

  return (
    <Dialog
      isOpen={isOpen}
      variant="fullscreen"
      onOpenChange={open => {
        if (!open) setConfigModalOpen(false)
      }}
      padding={0}
      className="settings-shell"
      aria-label="设置"
    >
      <div className="settings-shell__layout">
        <aside className="settings-shell__sidebar">
          <Button
            label="返回对话"
            variant="ghost"
            size="sm"
            className="settings-shell__back"
            onClick={() => setConfigModalOpen(false)}
          >
            ← 返回对话
          </Button>
          <SideNav className="settings-shell__nav">
            {NAV_GROUPS.map(group => (
              <SideNavSection key={group.title} title={group.title}>
                {group.items.map(item => (
                  <SideNavItem
                    key={item.id}
                    label={item.label}
                    isSelected={section === item.id}
                    onClick={() => selectSection(item.id)}
                    ref={el => {
                      navRefs.current[item.id] = el
                    }}
                  />
                ))}
              </SideNavSection>
            ))}
          </SideNav>
        </aside>

        <main className="settings-shell__pane">
          <header className="settings-shell__header">
            <h2 className="settings-shell__title">{active.label}</h2>
            <p className="settings-shell__desc">{active.description}</p>
          </header>
          <div className="settings-shell__content">
            {section === 'general' && <GeneralSettingsPanel />}
            {section === 'llm' && <LlmSettingsPanel />}
            {section === 'websearch' && <WebSearchSettingsPanel />}
            {section === 'memory' && <MemorySettingsPanel />}
            {section === 'rules' && <RulesSettingsPanel />}
            {section === 'skills' && <SkillsSettingsPanel />}
            {section === 'subagents' && <SubagentsSettingsPanel />}
            {section === 'permissions' && <PermissionsSettingsPanel />}
            {section === 'storage' && <StorageSettingsPanel />}
          </div>
        </main>
      </div>
    </Dialog>
  )
}
