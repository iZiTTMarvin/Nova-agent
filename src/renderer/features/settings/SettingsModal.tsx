/**
 * SettingsModal — 左右分栏设置壳层
 * 导航：LLM / 规则 / 技能 / 子代理
 */
import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { LlmSettingsPanel } from './LlmSettingsPanel'
import { RulesSettingsPanel } from './RulesSettingsPanel'
import { SkillsSettingsPanel } from './SkillsSettingsPanel'
import { SubagentsSettingsPanel } from './SubagentsSettingsPanel'
import './SettingsModal.css'

const NAV_STORAGE_KEY = 'nova-settings-nav'

export type SettingsSection = 'llm' | 'rules' | 'skills' | 'subagents'

const NAV_ITEMS: { id: SettingsSection; label: string }[] = [
  { id: 'llm', label: 'LLM 配置' },
  { id: 'rules', label: '规则' },
  { id: 'skills', label: '技能' },
  { id: 'subagents', label: '子代理' }
]

function readStoredSection(): SettingsSection {
  try {
    const raw = sessionStorage.getItem(NAV_STORAGE_KEY)
    if (raw === 'llm' || raw === 'rules' || raw === 'skills' || raw === 'subagents') {
      return raw
    }
  } catch {
    // sessionStorage 不可用时忽略
  }
  return 'llm'
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
    <div className="settings-modal-overlay" onClick={() => setConfigModalOpen(false)}>
      <div className="settings-modal settings-modal--wide" onClick={e => e.stopPropagation()}>
        <div className="settings-modal__header">
          <h2 className="settings-modal__title">设置</h2>
          <button
            className="settings-modal__close-btn"
            onClick={() => setConfigModalOpen(false)}
            aria-label="关闭"
            type="button"
          >
            &times;
          </button>
        </div>

        <div className="settings-modal__body">
          <nav className="settings-nav" aria-label="设置导航">
            {NAV_ITEMS.map(item => (
              <button
                key={item.id}
                type="button"
                className={`settings-nav__item${section === item.id ? ' settings-nav__item--active' : ''}`}
                onClick={() => selectSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="settings-modal__content">
            {section === 'llm' && <LlmSettingsPanel />}
            {section === 'rules' && <RulesSettingsPanel />}
            {section === 'skills' && <SkillsSettingsPanel />}
            {section === 'subagents' && <SubagentsSettingsPanel />}
          </div>
        </div>
      </div>
    </div>
  )
}
