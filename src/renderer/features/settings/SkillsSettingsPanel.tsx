/**
 * Skills 配置面板 — 列表、开关、第三方 skill 选项、创建与导入
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useSkillsStore } from '../skills/store'
import { SkillCard } from '../skills/SkillCard'
import { CreateSkillDialog } from '../skills/CreateSkillDialog'
import { SkillImportBar } from '../skills/SkillImportBar'
import { skillsI18n } from '../skills/i18n'
import { SettingsPage, SettingsSection } from './settingsKit'
import type { NovaSettingsDto } from '../../../shared/settings/types'
import type { SkillCatalogDiagnostic } from '../../../shared/skills/types'

const COLLAPSE_LIMIT = 5

export const SkillsSettingsPanel: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const requestComposerPrefill = useSettingsStore(state => state.requestComposerPrefill)
  const skills = useSkillsStore(state => state.skills)
  const skillsLoading = useSkillsStore(state => state.loading)
  const skillsError = useSkillsStore(state => state.error)
  const skillsDiagnostics = useSkillsStore(state => state.diagnostics)
  const refreshSkills = useSkillsStore(state => state.refresh)
  const setSnapshot = useSkillsStore(state => state.setSnapshot)

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

  const handleReload = useCallback(async () => {
    try {
      await window.nova.skill.reload(currentProject)
    } catch {
      // 失败已由 skill:changed 错误快照广播，store 会展示
    }
    await refreshSkills()
  }, [currentProject, refreshSkills])

  useEffect(() => {
    void loadSettings()
    void refreshSkills()
    const unsub = window.nova.skill.onChange(snapshot => setSnapshot(snapshot))
    return unsub
  }, [loadSettings, refreshSkills, setSnapshot])

  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name))
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSE_LIMIT)
  // 诊断按技能归属分组展示；无归属的目录级问题单列一行，不打断浏览
  const diagnosticsBySkill = useMemo(() => {
    const map = new Map<string, SkillCatalogDiagnostic[]>()
    for (const d of skillsDiagnostics) {
      if (!d.skillName) continue
      const list = map.get(d.skillName) ?? []
      list.push(d)
      map.set(d.skillName, list)
    }
    return map
  }, [skillsDiagnostics])
  const unattributedDiagnostics = skillsDiagnostics.filter(d => !d.skillName)

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

  const handleExport = async (name: string) => {
    try {
      const result = await window.nova.skill.export(name)
      if (!result.canceled && result.zipPath) {
        showToast(skillsI18n.exportSuccess(result.zipPath))
      }
    } catch (err) {
      showToast((err as Error).message)
    }
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

      <div className="settings-panel__scroll">
        <SettingsPage>
          <SettingsSection title="第三方技能" variant="bare">
            <CheckboxInput
              label={skillsI18n.loadThirdParty}
              description={skillsI18n.loadThirdPartyHint}
              value={settings?.loadThirdPartySkills ?? true}
              onChange={checked => void handleThirdPartyToggle(checked)}
              width="100%"
            />
          </SettingsSection>

          <SettingsSection
            title="技能列表"
            variant="bare"
            action={
              <>
                <Button
                  label={skillsI18n.reload}
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleReload()}
                >
                  {skillsI18n.reload}
                </Button>
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
              </>
            }
          >
            {importOpen && (
              <SkillImportBar hasProject={Boolean(currentProject)} onImported={handleImported} />
            )}

            {skillsError && (
              <Banner
                status="error"
                title="技能目录加载失败"
                description={skillsError}
                endContent={
                  <Button label="重试" variant="ghost" size="sm" onClick={() => void handleReload()}>
                    重试
                  </Button>
                }
              />
            )}
            {visible.length === 0 && !skillsError && (
              <p className="settings-panel__muted">
                {skillsLoading ? '加载中…' : skillsI18n.empty}
              </p>
            )}
            {unattributedDiagnostics.map((d, i) => (
              <p key={`${d.code}:${d.path ?? i}`} className="settings-panel__muted">
                {d.path ? `${d.message}（${d.path}）` : d.message}
              </p>
            ))}
            {visible.length > 0 && (
              <div className="skill-card-list">
                {visible.map(skill => (
                  <SkillCard
                    key={`${skill.source}:${skill.name}`}
                    skill={skill}
                    diagnostics={diagnosticsBySkill.get(skill.name)}
                    onToggle={handleToggle}
                    onUse={handleUse}
                    onExport={name => void handleExport(name)}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            )}

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
          </SettingsSection>
        </SettingsPage>
      </div>

      <CreateSkillDialog
        open={createOpen}
        hasProject={Boolean(currentProject)}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  )
}
