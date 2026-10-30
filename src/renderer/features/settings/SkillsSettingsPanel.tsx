/**
 * Skills 配置面板 — 第三方来源开关、两列技能小卡、详情弹窗、创建与导入
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useSkillsStore } from '../skills/store'
import { SkillTile } from '../skills/SkillTile'
import { SkillDetailDialog } from '../skills/SkillDetailDialog'
import { ThirdPartySkillSourceList } from '../skills/ThirdPartySkillSources'
import { CreateSkillDialog } from '../skills/CreateSkillDialog'
import { SkillImportBar } from '../skills/SkillImportBar'
import { skillsI18n } from '../skills/i18n'
import { confirmDialog } from '../confirm/confirmDialog'
import { SettingsGlassPanel, SettingsPage, SettingsSection, SettingsSegmented } from './settingsKit'
import type {
  SkillCatalogDiagnostic,
  SkillSummary,
  ThirdPartySkillSources as ThirdPartySkillSourcesValue
} from '../../../shared/skills/types'
import './SkillsSettingsPanel.css'

type SkillFilter = 'all' | 'mine' | 'third_party' | 'builtin'

function matchesFilter(skill: SkillSummary, filter: SkillFilter): boolean {
  switch (filter) {
    case 'mine':
      return skill.source === 'global' || skill.source === 'project'
    case 'third_party':
      return skill.source === 'third_party'
    case 'builtin':
      return skill.source === 'builtin'
    default:
      return true
  }
}

export const SkillsSettingsPanel: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const requestComposerPrefill = useSettingsStore(state => state.requestComposerPrefill)
  const skills = useSkillsStore(state => state.skills)
  const skillsLoading = useSkillsStore(state => state.loading)
  const skillsError = useSkillsStore(state => state.error)
  const skillsDiagnostics = useSkillsStore(state => state.diagnostics)
  const thirdPartySources = useSkillsStore(state => state.thirdPartySources)
  const refreshSkills = useSkillsStore(state => state.refresh)
  const setSnapshot = useSkillsStore(state => state.setSnapshot)

  const [searchQuery, setSearchQuery] = useState('')
  const [filter, setFilter] = useState<SkillFilter>('all')
  const [detailName, setDetailName] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 3200)
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
    void refreshSkills()
    return window.nova.skill.onChange(snapshot => setSnapshot(snapshot))
  }, [refreshSkills, setSnapshot])

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const filtered = useMemo(() => {
    return [...skills]
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter(skill => {
        if (!matchesFilter(skill, filter)) return false
        if (!normalizedQuery) return true
        return [skill.name, skill.nameZh, skill.description, skill.descriptionZh]
          .some(value => value?.toLocaleLowerCase().includes(normalizedQuery))
      })
  }, [filter, normalizedQuery, skills])

  const diagnosticsBySkill = useMemo(() => {
    const map = new Map<string, SkillCatalogDiagnostic[]>()
    for (const d of skillsDiagnostics) {
      if (!d.skillName) continue
      map.set(d.skillName, [...(map.get(d.skillName) ?? []), d])
    }
    return map
  }, [skillsDiagnostics])
  const unattributedDiagnostics = skillsDiagnostics.filter(d => !d.skillName)
  const detailSkill = detailName ? skills.find(skill => skill.name === detailName) : undefined

  const handleSourcesChange = async (next: ThirdPartySkillSourcesValue) => {
    try {
      await window.api.invoke('settings:set', { thirdPartySkillSources: next })
      await window.nova.skill.reload(currentProject)
    } catch (err) {
      showToast((err as Error).message)
    }
  }

  const handleUse = (name: string) => requestComposerPrefill(`/${name} `)

  const handleExport = async (name: string) => {
    try {
      const result = await window.nova.skill.export(name)
      if (!result.canceled && result.zipPath) showToast(skillsI18n.exportSuccess(result.zipPath))
    } catch (err) {
      showToast((err as Error).message)
    }
  }

  const handleDelete = async (name: string) => {
    const choice = await confirmDialog({
      type: 'warning',
      title: '删除技能',
      message: `确定删除技能「${name}」？`,
      detail: '技能目录会被永久删除。',
      buttons: ['取消', '删除'],
      defaultId: 0
    })
    if (choice !== 1) return
    try {
      await window.nova.skill.delete(name)
      showToast(`已删除技能「${name}」`)
    } catch (err) {
      showToast((err as Error).message)
    }
  }

  return (
    <SettingsGlassPanel className="skills-panel">
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
          <SettingsSection
            title={skillsI18n.thirdPartyTitle}
            description={skillsI18n.thirdPartyHint}
            variant="bare"
          >
            <ThirdPartySkillSourceList sources={thirdPartySources} onChange={handleSourcesChange} />
          </SettingsSection>

          <SettingsSection
            title="技能列表"
            variant="bare"
            action={
              <>
                <Button label={skillsI18n.reload} variant="ghost" size="sm" onClick={() => void handleReload()}>
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
                <Button label={skillsI18n.create} variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                  {skillsI18n.create}
                </Button>
              </>
            }
          >
            {importOpen && (
              <SkillImportBar hasProject={Boolean(currentProject)} onImported={name => showToast(skillsI18n.importSuccess(name))} />
            )}

            <div className="skill-settings__filters" role="search" aria-label={skillsI18n.searchLabel}>
              <div className="skill-settings__search">
                <TextInput
                  label={skillsI18n.searchLabel}
                  isLabelHidden
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder={skillsI18n.searchPlaceholder}
                  hasClear
                  size="sm"
                  width="100%"
                />
              </div>
              <SettingsSegmented
                label={skillsI18n.sourceFilterLabel}
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: skillsI18n.allSources },
                  { value: 'mine', label: skillsI18n.filterMine },
                  { value: 'third_party', label: skillsI18n.filterThirdParty },
                  { value: 'builtin', label: skillsI18n.filterBuiltin }
                ]}
              />
            </div>

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
            {filtered.length === 0 && !skillsError && (
              <p className="settings-panel__muted">
                {skillsLoading ? '加载中…' : skills.length === 0 ? skillsI18n.empty : skillsI18n.noSearchResults}
              </p>
            )}
            {unattributedDiagnostics.map((d, i) => (
              <p key={`${d.code}:${d.path ?? i}`} className="settings-panel__muted">
                {d.path ? `${d.message}（${d.path}）` : d.message}
              </p>
            ))}
            {filtered.length > 0 && (
              <ul className="skill-grid" aria-label="技能列表">
                {filtered.map(skill => (
                  <SkillTile
                    key={`${skill.source}:${skill.name}`}
                    skill={skill}
                    onOpen={item => setDetailName(item.name)}
                    onUse={handleUse}
                    onExport={name => void handleExport(name)}
                    onDelete={name => void handleDelete(name)}
                  />
                ))}
              </ul>
            )}
          </SettingsSection>
        </SettingsPage>
      </div>

      {detailSkill && (
        <SkillDetailDialog
          skill={detailSkill}
          diagnostics={diagnosticsBySkill.get(detailSkill.name)}
          onClose={() => setDetailName(null)}
          onUse={handleUse}
        />
      )}

      <CreateSkillDialog
        open={createOpen}
        hasProject={Boolean(currentProject)}
        onClose={() => setCreateOpen(false)}
        onCreated={name => showToast(skillsI18n.createSuccess(name))}
      />
    </SettingsGlassPanel>
  )
}
