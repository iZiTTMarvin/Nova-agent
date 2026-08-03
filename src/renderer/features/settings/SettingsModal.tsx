/**
 * SettingsModal — 左右分栏设置壳层
 * 导航：通用 / LLM / 规则 / 技能 / 子代理 / 权限
 */
import React, { useEffect, useState } from 'react'
import { Dialog } from '@astryxdesign/core/Dialog'
import { IconButton } from '@astryxdesign/core/IconButton'
import { SideNav, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { useSettingsStore } from '../../stores/useSettingsStore'
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

export type SettingsSection = 'general' | 'llm' | 'rules' | 'skills' | 'subagents' | 'permissions' | 'storage' | 'websearch' | 'memory'

const NAV_ITEMS: { id: SettingsSection; label: string }[] = [
  { id: 'general', label: '通用' },
  { id: 'llm', label: 'LLM 配置' },
  { id: 'websearch', label: '联网搜索' },
  { id: 'memory', label: '记忆' },
  { id: 'rules', label: '规则' },
  { id: 'skills', label: '技能' },
  { id: 'subagents', label: '子代理' },
  { id: 'permissions', label: '权限' },
  { id: 'storage', label: '存储' }
]

function readStoredSection(): SettingsSection {
  try {
    const raw = sessionStorage.getItem(NAV_STORAGE_KEY)
    if (
      raw === 'general' || raw === 'llm' || raw === 'rules' || raw === 'skills' ||
      raw === 'subagents' || raw === 'permissions' || raw === 'storage' || raw === 'websearch' ||
      raw === 'memory'
    ) {
      return raw
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
  }

  if (!isOpen) return null

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={open => {
        if (!open) setConfigModalOpen(false)
      }}
      width="min(96vw, 56rem)"
      maxHeight="min(88vh, 640px)"
      padding={0}
      className="settings-modal settings-modal--wide"
      aria-label="设置"
    >
      <div className="settings-modal__header">
        <h2 className="settings-modal__title">设置</h2>
        <IconButton
          className="settings-modal__close-btn"
          onClick={() => setConfigModalOpen(false)}
          aria-label="关闭"
          label="关闭"
          icon={<span aria-hidden="true">×</span>}
          variant="ghost"
          size="sm"
        />
      </div>

      <div className="settings-modal__body">
        <SideNav className="settings-nav">
          <SideNavSection title="设置" isHeaderHidden>
            {NAV_ITEMS.map(item => (
              <SideNavItem
                key={item.id}
                label={item.label}
                isSelected={section === item.id}
                onClick={() => selectSection(item.id)}
              />
            ))}
          </SideNavSection>
        </SideNav>

        <div className="settings-modal__content">
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
      </div>
    </Dialog>
  )
}
