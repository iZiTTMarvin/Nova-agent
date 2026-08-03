/**
 * Skills 配置面板 — 列表、开关、第三方 skill 选项、创建与导入
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useSkillsStore } from '../skills/store'
import { SkillCard } from '../skills/SkillCard'
import { CreateSkillDialog } from '../skills/CreateSkillDialog'
import { SkillImportBar } from '../skills/SkillImportBar'
import { skillsI18n } from '../skills/i18n'
import type { NovaSettingsDto } from '../../../shared/settings/types'

const COLLAPSE_LIMIT = 5

export const SkillsSettingsPanel: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const requestComposerPrefill = useSettingsStore(state => state.requestComposerPrefill)
  const skills = useSkillsStore(state => state.skills)
  const refreshSkills = useSkillsStore(state => state.refresh)
  const setSkills = useSkillsStore(state => state.setSkills)

  const [settings, setSettings] = useState<NovaSettingsDto | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 3200)
  }, [])

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
    await window.nova.skill.reload(currentProject)
  }

  const handleToggle = async (name: string, enabled: boolean) => {
    try {
      await window.nova.skill.toggle(name, enabled)
      // skill:changed → onChange 已更新列表，无需再 refresh
    } catch (err) {
      showToast((err as Error).message)
    }
  }

  const handleUse = (name: string) => {
    requestComposerPrefill(`/${name} `)
  }

  const handleDelete = async (name: string) => {
    if (!window.confirm(`确定删除技能「${name}」？`)) return
    try {
      await window.nova.skill.delete(name)
      // skill:changed → onChange 已更新列表
      showToast(`已删除技能「${name}」`)
    } catch (err) {
      showToast((err as Error).message)
    }
  }

  const handleCreated = (name: string) => {
    showToast(skillsI18n.createSuccess(name))
  }

  const handleImported = (name: string) => {
    showToast(skillsI18n.importSuccess(name))
  }

  return (
    <div className="settings-panel">
      {toast && (
        <Banner
          status="info"
          title={toast}
          isDismissable
          onDismiss={() => setToast(null)}
          className="skill-settings-toast"
        />
      )}

      <header className="settings-panel__header settings-panel__header--row">
        <div>
          <h3 className="settings-panel__title">{skillsI18n.panelTitle}</h3>
          <p className="settings-panel__desc">{skillsI18n.panelDesc}</p>
        </div>
        <div className="settings-panel__header-actions">
          <Button
            label={importOpen ? skillsI18n.hideImportBar : skillsI18n.import}
            variant="secondary"
            size="sm"
            onClick={() => setImportOpen(v => !v)}
          >
            {importOpen ? skillsI18n.hideImportBar : skillsI18n.import}
          </Button>
          <Button
            label={skillsI18n.create}
            variant="primary"
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            {skillsI18n.create}
          </Button>
        </div>
      </header>

      <CheckboxInput
        label={skillsI18n.loadThirdParty}
        description={skillsI18n.loadThirdPartyHint}
        value={settings?.loadThirdPartySkills ?? true}
        onChange={checked => void handleThirdPartyToggle(checked)}
        className="settings-toggle-row"
        width="100%"
      />

      {importOpen && (
        <SkillImportBar hasProject={Boolean(currentProject)} onImported={handleImported} />
      )}

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
        <Button
          label={expanded ? skillsI18n.showLess : `${skillsI18n.showAll}（${sorted.length}）`}
          variant="ghost"
          size="sm"
          className="settings-panel__link-btn"
          onClick={() => setExpanded(v => !v)}
        >
          {expanded ? skillsI18n.showLess : `${skillsI18n.showAll}（${sorted.length}）`}
        </Button>
      )}

      <CreateSkillDialog
        open={createOpen}
        hasProject={Boolean(currentProject)}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  )
}
