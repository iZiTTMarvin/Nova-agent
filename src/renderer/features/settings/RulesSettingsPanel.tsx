/**
 * Rules 配置面板 — 列表 + textarea 编辑器
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { rulesI18n } from '../skills/i18n'
import type { RuleFileEntry } from '../../../shared/settings/types'
import type { RuleScope } from '../../../runtime/agent/rulesDiscovery'

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
    <div className="settings-panel settings-panel--split">
      <header className="settings-panel__header settings-panel__header--row">
        <div>
          <h3 className="settings-panel__title">{rulesI18n.panelTitle}</h3>
          <p className="settings-panel__desc">{rulesI18n.panelDesc}</p>
        </div>
        <button type="button" className="settings-panel__primary-btn" onClick={handleCreate}>
          {rulesI18n.create}
        </button>
      </header>

      <div className="settings-split">
        <aside className="settings-split__list">
          {loading && <p className="settings-panel__muted">加载中…</p>}
          {!loading && rules.length === 0 && (
            <p className="settings-panel__muted">{rulesI18n.empty}</p>
          )}
          {rules.map(rule => (
            <button
              key={rule.id}
              type="button"
              className={`settings-split__item${selectedId === rule.id ? ' settings-split__item--active' : ''}`}
              onClick={() => setSelectedId(rule.id)}
            >
              <span className="settings-split__item-title">{rule.relativePath}</span>
              <span className="settings-split__item-meta">
                {rule.scope === 'workspace' ? rulesI18n.scopeWorkspace : rulesI18n.scopeGlobal}
              </span>
            </button>
          ))}
        </aside>

        <div className="settings-split__editor">
          {selected ? (
            <>
              <textarea
                className="settings-editor"
                value={content}
                onChange={e => setContent(e.target.value)}
                spellCheck={false}
              />
              <div className="settings-editor__footer">
                {status && <span className="settings-panel__status">{status}</span>}
                <button
                  type="button"
                  className="settings-panel__primary-btn"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? '保存中…' : rulesI18n.save}
                </button>
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
