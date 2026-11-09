/**
 * PilotSettingsPanel — 领航模式技能选择与偏好设置
 *
 * 负责：
 * - 候选技能列表（来源于默认模式真实有效的 Slash 候选）
 * - 领航斜杠技能许可（pilotSkillIds）的勾选与持久化
 * - 首次进入的领域技能推荐指引（pilotSkillGuideSeen）
 * - 失效选择（原技能删除/来源变更）的独立展示与移除
 * - 快速跳转至「技能」管理页新建/导入技能
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Switch } from '@astryxdesign/core/Switch'
import { TextInput } from '@astryxdesign/core/TextInput'
import { SettingsCard, SettingsGlassPanel, SettingsPage } from './settingsKit'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type { NovaSettingsDto } from '../../../shared/settings/types'
import type { SkillSummary } from '../../../shared/skills/types'
import './PilotSettingsPanel.css'

function parseSkillId(id: string): { name: string; source: string; sourcePath: string; workspaceRoot: string } | null {
  try {
    const parsed = JSON.parse(id)
    if (Array.isArray(parsed) && parsed.length === 4) {
      return {
        name: typeof parsed[0] === 'string' ? parsed[0] : '',
        source: typeof parsed[1] === 'string' ? parsed[1] : '',
        sourcePath: typeof parsed[2] === 'string' ? parsed[2] : '',
        workspaceRoot: typeof parsed[3] === 'string' ? parsed[3] : ''
      }
    }
  } catch {
    // 忽略非法 JSON
  }
  return null
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'builtin':
      return '内置'
    case 'global':
      return '本地'
    case 'project':
      return '项目'
    case 'third_party':
      return '第三方'
    case 'virtual':
      return '虚拟'
    case 'mcp':
      return 'MCP'
    default:
      return source || '未知'
  }
}

export const PilotSettingsPanel: React.FC = () => {
  const openCustomizeSettings = useSettingsStore(state => state.openCustomizeSettings)
  const [settings, setSettings] = useState<NovaSettingsDto | null>(null)
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showGuide, setShowGuide] = useState(false)
  const settingsRef = useRef<NovaSettingsDto | null>(null)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())

  const loadData = useCallback(async () => {
    try {
      const [s, snapshot] = await Promise.all([
        window.api.invoke('settings:get') as Promise<NovaSettingsDto>,
        window.nova.skill.list({ mode: 'default' })
      ])
      settingsRef.current = s
      setSettings(s)
      setSkills(snapshot.skills)
      if (!s.pilotSkillGuideSeen) {
        setShowGuide(true)
        void window.api.invoke('settings:set', { pilotSkillGuideSeen: true })
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载领航设置失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
    const unsubscribe = window.nova.skill.onChange(() => {
      void window.nova.skill.list({ mode: 'default' }).then(snapshot => {
        setSkills(snapshot.skills)
      })
    })
    return unsubscribe
  }, [loadData])

  const candidateIds = useMemo(() => new Set(skills.map(s => s.skillId)), [skills])

  const staleIds = useMemo(() => {
    if (!settings?.pilotSkillIds) return []
    return settings.pilotSkillIds.filter(id => !candidateIds.has(id))
  }, [settings?.pilotSkillIds, candidateIds])

  const updatePilotSkillIds = useCallback((update: (current: string[]) => string[]) => {
    const current = settingsRef.current
    if (!current) return
    const nextList = update(current.pilotSkillIds)
    const optimistic = { ...current, pilotSkillIds: nextList }
    settingsRef.current = optimistic
    setSettings(optimistic)

    // 整数组写入按点击顺序串行；旧请求失败后的回读也不能覆盖更新的本地意图。
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      try {
        await window.api.invoke('settings:set', { pilotSkillIds: nextList })
      } catch {
        if (settingsRef.current?.pilotSkillIds !== nextList) return
        try {
          const latest = await window.api.invoke('settings:get') as NovaSettingsDto
          if (settingsRef.current?.pilotSkillIds !== nextList) return
          settingsRef.current = latest
          setSettings(latest)
          setError('技能选择保存失败，请重试')
        } catch (err) {
          setError(err instanceof Error ? err.message : '技能选择保存失败，请重试')
        }
      }
    })
  }, [])

  const toggleSkill = (skillId: string, enabled: boolean) => {
    updatePilotSkillIds(currentIds => {
      const next = new Set(currentIds)
      if (enabled) {
        next.add(skillId)
      } else {
        next.delete(skillId)
      }
      return Array.from(next)
    })
  }

  const removeStaleId = (idToRemove: string) => {
    updatePilotSkillIds(currentIds => currentIds.filter(id => id !== idToRemove))
  }

  const removeAllStaleIds = () => {
    const staleSet = new Set(staleIds)
    updatePilotSkillIds(currentIds => currentIds.filter(id => !staleSet.has(id)))
  }

  const normalizedQuery = searchQuery.trim().toLowerCase()
  const filteredSkills = useMemo(() => {
    if (!normalizedQuery) return skills
    return skills.filter(skill => {
      const name = skill.name.toLowerCase()
      const desc = (skill.descriptionZh || skill.description).toLowerCase()
      return name.includes(normalizedQuery) || desc.includes(normalizedQuery)
    })
  }, [skills, normalizedQuery])

  if (loading && !settings) {
    return (
      <SettingsGlassPanel className="pilot-settings-panel">
        <div className="settings-panel__scroll">
          <p className="settings-panel__muted">加载中…</p>
        </div>
      </SettingsGlassPanel>
    )
  }

  return (
    <SettingsGlassPanel className="pilot-settings-panel">
      <div className="settings-panel__scroll">
        <SettingsPage>
          {showGuide && (
            <div className="pilot-settings-guide">
              <Banner
                status="info"
                title="领航模式技能推荐"
                description="建议加入前端设计、框架知识等领域技能；完整工作流技能可能与领航的方法重复。"
                isDismissable
                onDismiss={() => setShowGuide(false)}
              />
            </div>
          )}

          {error && (
            <Banner
              status="error"
              title="设置操作失败"
              description={error}
              isDismissable
              onDismiss={() => setError(null)}
            />
          )}

          {staleIds.length > 0 && (
            <SettingsCard
              title="已失效的技能选择"
              description="以下技能在当前工作区不存在、已被删除或来源已变更。领航模式将不会加载这些技能。"
              className="pilot-stale-card"
              aside={
                staleIds.length > 1 ? (
                  <Button
                    label="清理全部失效项"
                    size="sm"
                    variant="ghost"
                    onClick={() => void removeAllStaleIds()}
                  >
                    清理全部失效项
                  </Button>
                ) : undefined
              }
            >
              <div className="pilot-stale-list">
                {staleIds.map(id => {
                  const parsed = parseSkillId(id)
                  const name = parsed?.name || id
                  const source = parsed ? sourceLabel(parsed.source) : '未知'
                  return (
                    <div key={id} className="pilot-stale-row">
                      <div className="pilot-stale-row__content">
                        <span className="pilot-stale-row__name">/{name}</span>
                        <span className="glass-chip glass-chip--danger">不可用</span>
                        <span className="pilot-stale-row__detail">原来源：{source}</span>
                      </div>
                      <Button
                        label="移除"
                        size="sm"
                        variant="ghost"
                        onClick={() => void removeStaleId(id)}
                      >
                        移除
                      </Button>
                    </div>
                  )
                })}
              </div>
            </SettingsCard>
          )}

          <SettingsCard
            title="斜杠可用技能"
            description="选择可在领航模式中通过 / 手动调用的技能。未选中的技能不会自动触发，也不会出现在领航的斜杠列表中。"
            aside={
              <div className="pilot-settings__card-aside">
                {skills.length >= 5 && (
                  <div className="pilot-settings__search">
                    <TextInput
                      label="搜索技能"
                      isLabelHidden
                      value={searchQuery}
                      onChange={setSearchQuery}
                      placeholder="搜索技能…"
                      hasClear
                      size="sm"
                      width="100%"
                    />
                  </div>
                )}
                <Button
                  label="管理可用技能"
                  size="sm"
                  variant="secondary"
                  onClick={() => openCustomizeSettings('skills')}
                >
                  管理可用技能
                </Button>
              </div>
            }
          >
            {skills.length === 0 ? (
              <div className="pilot-empty-card">
                <p className="pilot-empty-card__text">
                  当前工作区未检测到可用技能。你可以前往技能管理页添加自定义或内置技能。
                </p>
                <Button
                  label="选择技能"
                  size="sm"
                  variant="primary"
                  onClick={() => openCustomizeSettings('skills')}
                >
                  选择技能
                </Button>
              </div>
            ) : filteredSkills.length === 0 ? (
              <div className="pilot-empty-card">
                <p className="pilot-empty-card__text">没有找到匹配「{searchQuery}」的技能。</p>
              </div>
            ) : (
              <div className="pilot-skill-list">
                {filteredSkills.map(skill => {
                  const isChecked = Boolean(settings?.pilotSkillIds?.includes(skill.skillId))
                  return (
                    <div key={skill.skillId} className="pilot-skill-row">
                      <div className="pilot-skill-row__content">
                        <div className="pilot-skill-row__title">
                          <span className="pilot-skill-row__name">/{skill.name}</span>
                          <span className="glass-chip">{sourceLabel(skill.source)}</span>
                        </div>
                        <div className="pilot-skill-row__desc" title={skill.descriptionZh || skill.description}>
                          {skill.descriptionZh || skill.description}
                        </div>
                      </div>
                      <div className="pilot-skill-row__control">
                        <Switch
                          label={`允许在领航中调用 /${skill.name}`}
                          isLabelHidden
                          value={isChecked}
                          onChange={checked => void toggleSkill(skill.skillId, checked)}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </SettingsCard>
        </SettingsPage>
      </div>
    </SettingsGlassPanel>
  )
}
