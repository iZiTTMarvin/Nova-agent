/**
 * Rules 配置面板 — 列表 + textarea 编辑器
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { ClickableCard } from '@astryxdesign/core/ClickableCard'
import { TextArea } from '@astryxdesign/core/TextArea'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { rulesI18n } from '../skills/i18n'
import type { RuleFileEntry } from '../../../shared/settings/types'
import type { RuleScope } from '../../../shared/settings/types'

export const RulesSettingsPanel: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const [rules, setRules] = useState<RuleFileEntry[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const selected = rules.find(r => r.id === selectedId) ?? null

  const loadRules = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.invoke('rules:list', { workspaceRoot: currentProject })
      setRules(list)
      if (list.length > 0 && !list.some(r => r.id === selectedId)) {
        setSelectedId(list[0].id)
      }
    } finally {
      setLoading(false)
    }
  }, [currentProject, selectedId])

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  useEffect(() => {
    if (!selected) {
      setContent('')
      return
    }
    let cancelled = false
    void window.api
      .invoke('rules:read', { absolutePath: selected.absolutePath, workspaceRoot: currentProject })
      .then(text => {
        if (!cancelled) setContent(text)
      })
      .catch(() => {
        if (!cancelled) setContent('')
      })
    return () => {
      cancelled = true
    }
  }, [selected, currentProject])

  const handleSave = async () => {
    if (!selected) return
    setSaving(true)
    setStatus(null)
    try {
      await window.api.invoke('rules:write', {
        absolutePath: selected.absolutePath,
        content,
        workspaceRoot: currentProject
      })
      setStatus(rulesI18n.saved)
      setTimeout(() => setStatus(null), 2000)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleCreate = async () => {
    const name = window.prompt(rulesI18n.newRulePrompt)
    if (!name?.trim()) return

    let scope: RuleScope = 'global'
    if (currentProject) {
      const choice = window.prompt(`${rulesI18n.newRuleScope}：输入 global 或 workspace`, 'workspace')
      scope = choice?.trim() === 'global' ? 'global' : 'workspace'
    }

    if (scope === 'workspace' && !currentProject) {
      window.alert(rulesI18n.needProject)
      return
    }

    try {
      const created = await window.api.invoke('rules:create', {
        name: name.trim(),
        scope,
        workspaceRoot: currentProject,
        content: `# ${name.trim()}\n\n`
      })
      await loadRules()
      setSelectedId(created.id)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '创建失败')
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel__toolbar">
        <Button label={rulesI18n.create} variant="primary" size="sm" onClick={handleCreate}>
          {rulesI18n.create}
        </Button>
      </div>

      <div className="settings-split">
        <aside className="settings-split__list">
          {loading && <p className="settings-panel__muted">加载中…</p>}
          {!loading && rules.length === 0 && (
            <p className="settings-panel__muted">{rulesI18n.empty}</p>
          )}
          {rules.map(rule => (
            <ClickableCard
              key={rule.id}
              label={rule.relativePath}
              variant="transparent"
              padding={0}
              width="100%"
              className={`settings-split__item${selectedId === rule.id ? ' settings-split__item--active' : ''}`}
              onClick={() => setSelectedId(rule.id)}
            >
              <span className="settings-split__item-title">{rule.relativePath}</span>
              <span className="settings-split__item-meta">
                {rule.scope === 'workspace' ? rulesI18n.scopeWorkspace : rulesI18n.scopeGlobal}
              </span>
            </ClickableCard>
          ))}
        </aside>

        <div className="settings-split__editor">
          {selected ? (
            <>
              <TextArea
                label="规则文件内容"
                isLabelHidden
                className="settings-editor"
                value={content}
                onChange={value => setContent(value)}
                hasSpellCheck={false}
                width="100%"
              />
              <div className="settings-editor__footer">
                {status && <span className="settings-panel__status">{status}</span>}
                <Button
                  label={saving ? '保存中…' : rulesI18n.save}
                  variant="primary"
                  size="sm"
                  onClick={handleSave}
                  isDisabled={saving}
                >
                  {saving ? '保存中…' : rulesI18n.save}
                </Button>
              </div>
            </>
          ) : (
            <p className="settings-panel__muted settings-panel__muted--center">{rulesI18n.selectHint}</p>
          )}
        </div>
      </div>
    </div>
  )
}
