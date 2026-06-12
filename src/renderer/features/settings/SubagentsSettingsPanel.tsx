/**
 * Subagents 配置面板 — 内置 + 自定义 JSON
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { subagentsI18n } from '../skills/i18n'
import type { SubagentListItem } from '../../../shared/settings/types'
import type { SubAgentSpec } from '../../../runtime/agent/SubAgentConfig'

const EMPTY_TEMPLATE: SubAgentSpec = {
  name: '',
  description: '',
  allowedTools: ['ls', 'read', 'grep'],
  prompt: '你是一个子代理助手。',
  maxToolRounds: 20
}

export const SubagentsSettingsPanel: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const [items, setItems] = useState<SubagentListItem[]>([])
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [jsonText, setJsonText] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const selected = items.find(i => i.name === selectedName) ?? null

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.invoke('subagents:list', { workspaceRoot: currentProject })
      setItems(list)
      if (list.length > 0 && !list.some(i => i.name === selectedName)) {
        setSelectedName(list[0].name)
      }
    } finally {
      setLoading(false)
    }
  }, [currentProject, selectedName])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    if (selected) {
      const spec: SubAgentSpec = {
        name: selected.name,
        description: selected.description,
        allowedTools: selected.allowedTools,
        prompt: selected.prompt,
        model: selected.model,
        maxToolRounds: selected.maxToolRounds,
        contextWindow: selected.contextWindow
      }
      setJsonText(JSON.stringify(spec, null, 2))
    } else {
      setJsonText('')
    }
  }, [selected])

  const handleCreate = async () => {
    const name = window.prompt(subagentsI18n.newNamePrompt)
    if (!name?.trim()) return

    const spec: SubAgentSpec = { ...EMPTY_TEMPLATE, name: name.trim() }
    let location: 'global' | 'project' = 'global'
    if (currentProject) {
      const choice = window.prompt('保存位置：global 或 project', 'global')
      location = choice?.trim() === 'project' ? 'project' : 'global'
    }

    try {
      const saved = await window.api.invoke('subagents:save', {
        spec,
        location,
        workspaceRoot: currentProject
      })
      await loadList()
      setSelectedName(saved.name)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '创建失败')
    }
  }

  const handleSave = async () => {
    if (!selected || selected.builtin) return
    const snapshot = jsonText
    setSaving(true)
    setSaveError(null)
    try {
      const spec = JSON.parse(jsonText) as SubAgentSpec
      await window.api.invoke('subagents:save', {
        spec,
        location: selected.origin === 'project' ? 'project' : 'global',
        workspaceRoot: currentProject
      })
      await loadList()
    } catch (err) {
      // JSON 解析失败时保留 textarea 内容，仅展示错误
      setJsonText(snapshot)
      setSaveError(err instanceof Error ? err.message : '保存失败，请检查 JSON 格式')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!selected || selected.builtin) return
    if (!window.confirm(`确定删除子代理「${selected.name}」？`)) return
    try {
      await window.api.invoke('subagents:delete', { name: selected.name, workspaceRoot: currentProject })
      setSelectedName(null)
      await loadList()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="settings-panel settings-panel--split">
      <header className="settings-panel__header settings-panel__header--row">
        <div>
          <h3 className="settings-panel__title">{subagentsI18n.panelTitle}</h3>
          <p className="settings-panel__desc">{subagentsI18n.panelDesc}</p>
        </div>
        <button type="button" className="settings-panel__primary-btn" onClick={handleCreate}>
          {subagentsI18n.create}
        </button>
      </header>

      <div className="settings-split">
        <aside className="settings-split__list">
          {loading && <p className="settings-panel__muted">加载中…</p>}
          {!loading && items.length === 0 && (
            <p className="settings-panel__muted">{subagentsI18n.empty}</p>
          )}
          {items.map(item => (
            <button
              key={item.name}
              type="button"
              className={`settings-split__item${selectedName === item.name ? ' settings-split__item--active' : ''}`}
              onClick={() => setSelectedName(item.name)}
            >
              <span className="settings-split__item-title">{item.name}</span>
              <span className="settings-split__item-meta">
                {item.builtin ? subagentsI18n.builtin : subagentsI18n.custom}
              </span>
            </button>
          ))}
        </aside>

        <div className="settings-split__editor">
          {selected ? (
            <>
              <div className="subagent-detail">
                <p className="subagent-detail__desc">{selected.description}</p>
                <p className="subagent-detail__tools">
                  {subagentsI18n.allowedTools}：{(selected.allowedTools ?? []).join(', ')}
                </p>
              </div>
              {selected.builtin ? (
                <pre className="settings-readonly-json">{jsonText}</pre>
              ) : (
                <>
                  <p className="settings-panel__muted">{subagentsI18n.editJson}</p>
                  <textarea
                    className="settings-editor"
                    value={jsonText}
                    onChange={e => {
                      setJsonText(e.target.value)
                      setSaveError(null)
                    }}
                    spellCheck={false}
                  />
                  <div className="settings-editor__footer">
                    {saveError && <span className="settings-panel__status settings-panel__status--error">{saveError}</span>}
                    <button
                      type="button"
                      className="settings-panel__ghost-btn settings-panel__ghost-btn--danger"
                      onClick={handleDelete}
                    >
                      {subagentsI18n.delete}
                    </button>
                    <button
                      type="button"
                      className="settings-panel__primary-btn"
                      onClick={handleSave}
                      disabled={saving}
                    >
                      {saving ? '保存中…' : subagentsI18n.save}
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <p className="settings-panel__muted settings-panel__muted--center">{subagentsI18n.empty}</p>
          )}
        </div>
      </div>
    </div>
  )
}
