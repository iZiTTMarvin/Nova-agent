/**
 * Skills 配置面板 — 列表、开关、第三方 skill 选项
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useSkillsStore } from '../skills/store'
import { SkillCard } from '../skills/SkillCard'
import { skillsI18n } from '../skills/i18n'
import type { NovaSettingsDto } from '../../../shared/settings/types'

const COLLAPSE_LIMIT = 5

export const SkillsSettingsPanel: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const requestComposerPrefill = useSettingsStore(state => state.requestComposerPrefill)
  const skills = useSkillsStore(state => state.skills)
  const refreshSkills = useSkillsStore(state => state.refresh)
  const setSkills = useSkillsStore(state => state.setSkills)

  const [settings, setSettings] = useState<NovaSettingsDto>({ loadThirdPartySkills: true })
  const [expanded, setExpanded] = useState(false)

  const loadSettings = useCallback(async () => {
    const s = await window.api.invoke('settings:get')
    setSettings(s)
  }, [])

  useEffect(() => {
    void loadSettings()
    void refreshSkills()
    const unsub = window.nova.skill.onChange(list => setSkills(list))
    return unsub
  }, [loadSettings, refreshSkills, setSkills])

  useEffect(() => {
    if (currentProject) {
      void window.nova.skill.reload(currentProject)
    }
  }, [currentProject])

  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name))
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSE_LIMIT)

  const handleThirdPartyToggle = async (checked: boolean) => {
    const next = await window.api.invoke('settings:set', { loadThirdPartySkills: checked })
    setSettings(next)
    // Task 13 运行时读取此开关；此处先 reload 以便后续接入
    // reload 会触发 skill:changed → onChange，无需再 refreshSkills
    await window.nova.skill.reload(currentProject)
  }

  const handleToggle = async (name: string, enabled: boolean) => {
    await window.nova.skill.toggle(name, enabled)
    await refreshSkills()
  }

  const handleUse = (name: string) => {
    requestComposerPrefill(`/${name} `)
  }

  const handleDelete = async (name: string) => {
    if (!window.confirm(`确定删除技能「${name}」？`)) return
    await window.nova.skill.delete(name)
    await refreshSkills()
  }

  return (
    <div className="settings-panel">
      <header className="settings-panel__header settings-panel__header--row">
        <div>
          <h3 className="settings-panel__title">{skillsI18n.panelTitle}</h3>
          <p className="settings-panel__desc">{skillsI18n.panelDesc}</p>
        </div>
        <div className="settings-panel__header-actions">
          <button
            type="button"
            className="settings-panel__ghost-btn"
            onClick={() => window.alert(skillsI18n.importNotReady)}
          >
            {skillsI18n.import}
          </button>
          <button
            type="button"
            className="settings-panel__primary-btn"
            onClick={() => window.alert(skillsI18n.createNotReady)}
          >
            {skillsI18n.create}
          </button>
        </div>
      </header>

      <label className="settings-toggle-row">
        <input
          type="checkbox"
          checked={settings.loadThirdPartySkills}
          onChange={e => void handleThirdPartyToggle(e.target.checked)}
        />
        <span className="settings-toggle-row__label">{skillsI18n.loadThirdParty}</span>
        <span className="settings-toggle-row__hint">{skillsI18n.loadThirdPartyHint}</span>
      </label>

      <div className="settings-panel__scroll skill-card-list">
        {visible.length === 0 && <p className="settings-panel__muted">{skillsI18n.empty}</p>}
        {visible.map(skill => (
          <SkillCard
            key={`${skill.source}:${skill.name}`}
            skill={skill}
            onToggle={handleToggle}
            onUse={handleUse}
            onDelete={handleDelete}
          />
        ))}
      </div>

      {sorted.length > COLLAPSE_LIMIT && (
        <button
          type="button"
          className="settings-panel__link-btn"
          onClick={() => setExpanded(v => !v)}
        >
          {expanded ? skillsI18n.showLess : `${skillsI18n.showAll}（${sorted.length}）`}
        </button>
      )}
    </div>
  )
}
