/**
 * Subagents 配置面板 — 内置 + 自定义 JSON
 *
 * 只维护未提交草稿与页面选择状态；preset 真源在 presetStore，
 * 保存后以主进程返回的权威结果对账。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { ClickableCard } from '@astryxdesign/core/ClickableCard'
import { TextArea } from '@astryxdesign/core/TextArea'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { subagentsI18n } from '../skills/i18n'
import type {
  SubAgentSpec,
  SubagentListItem,
  SubagentPresetDiagnostic
} from '../../../shared/settings/types'
import { generateSubagentPresetId } from '../../../shared/subagents'

const EMPTY_TEMPLATE: Omit<SubAgentSpec, 'id' | 'name'> = {
  description: '',
  enabled: true,
  allowedTools: ['ls', 'read', 'grep'],
  prompt: '你是一个子代理助手。',
  maxToolRounds: 20
}

export const SubagentsSettingsPanel: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const [items, setItems] = useState<SubagentListItem[]>([])
  const [diagnostics, setDiagnostics] = useState<SubagentPresetDiagnostic[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [jsonText, setJsonText] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const selected = items.find(i => i.id === selectedId) ?? null

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.invoke('subagents:list', { workspaceRoot: currentProject })
      setItems(result.items)
      setDiagnostics(result.diagnostics)
      if (result.items.length > 0 && !result.items.some(i => i.id === selectedId)) {
        setSelectedId(result.items[0].id)
      }
    } finally {
      setLoading(false)
    }
  }, [currentProject, selectedId])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    if (selected) {
      const spec: SubAgentSpec = {
        id: selected.id,
        name: selected.name,
        description: selected.description,
        enabled: selected.enabled,
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

    const preset: SubAgentSpec = {
      ...EMPTY_TEMPLATE,
      id: generateSubagentPresetId(name, items.map(i => i.id)),
      name: name.trim()
    }
    let location: 'global' | 'project' = 'global'
    if (currentProject) {
      const choice = window.prompt('保存位置：global 或 project', 'global')
      location = choice?.trim() === 'project' ? 'project' : 'global'
    }

    try {
      const saved = await window.api.invoke('subagents:create', {
        preset,
        location,
        workspaceRoot: currentProject
      })
      await loadList()
      setSelectedId(saved.id)
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
      const preset = JSON.parse(jsonText) as SubAgentSpec
      await window.api.invoke('subagents:update', {
        id: selected.id,
        preset,
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
      await window.api.invoke('subagents:delete', {
        id: selected.id,
        location: selected.origin === 'project' ? 'project' : 'global',
        workspaceRoot: currentProject
      })
      setSelectedId(null)
      await loadList()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel__toolbar">
        <Button label={subagentsI18n.create} variant="primary" size="sm" onClick={handleCreate}>
          {subagentsI18n.create}
        </Button>
      </div>

      <div className="settings-split">
        <aside className="settings-split__list">
          {loading && <p className="settings-panel__muted">加载中…</p>}
          {!loading && items.length === 0 && (
            <p className="settings-panel__muted">{subagentsI18n.empty}</p>
          )}
          {diagnostics.map((diagnostic, index) => (
            <p key={`${diagnostic.code}-${index}`} className="settings-panel__status settings-panel__status--error">
              {diagnostic.location}：{diagnostic.message}
            </p>
          ))}
          {items.map(item => (
            <ClickableCard
              key={item.id}
              label={item.name}
              variant="transparent"
              padding={0}
              width="100%"
              className={`settings-split__item${selectedId === item.id ? ' settings-split__item--active' : ''}`}
              onClick={() => setSelectedId(item.id)}
            >
              <span className="settings-split__item-title">{item.name}</span>
              <span className="settings-split__item-meta">
                {item.builtin
                  ? subagentsI18n.builtin
                  : item.enabled
                    ? subagentsI18n.custom
                    : `${subagentsI18n.custom} · 已禁用`}
              </span>
            </ClickableCard>
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
                  <TextArea
                    label="子代理 JSON"
                    isLabelHidden
                    className="settings-editor"
                    value={jsonText}
                    onChange={value => {
                      setJsonText(value)
                      setSaveError(null)
                    }}
                    hasSpellCheck={false}
                    width="100%"
                  />
                  <div className="settings-editor__footer">
                    {saveError && <span className="settings-panel__status settings-panel__status--error">{saveError}</span>}
                    <Button
                      label={subagentsI18n.delete}
                      variant="destructive"
                      size="sm"
                      onClick={handleDelete}
                    >
                      {subagentsI18n.delete}
                    </Button>
                    <Button
                      label={saving ? '保存中…' : subagentsI18n.save}
                      variant="primary"
                      size="sm"
                      onClick={handleSave}
                      isDisabled={saving}
                    >
                      {saving ? '保存中…' : subagentsI18n.save}
                    </Button>
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
