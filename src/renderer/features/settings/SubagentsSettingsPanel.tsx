import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Selector } from '@astryxdesign/core/Selector'
import { Switch } from '@astryxdesign/core/Switch'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useSettingsStore } from '../../stores/useSettingsStore'
import {
  getSupportedReasoningEfforts,
  listSelectableModels,
  type LlmRegistry
} from '../../../shared/config'
import {
  generateSubagentPresetId,
  isValidSubagentPresetId
} from '../../../shared/subagents'
import type {
  SubAgentSpec,
  SubagentListItem,
  SubagentPresetDiagnostic,
  SubagentPresetLocation,
  SubagentToolOption
} from '../../../shared/settings/types'
import {
  SubagentPresetForm,
  type SubagentFieldErrors,
  type SubagentPresetDraft
} from './SubagentPresetForm'

interface AbilityTemplate {
  id: string
  name: string
  description: string
  prompt: string
  allowedTools: string[]
  /** 未声明时新建 preset 不预填轮数，保存后按权限档默认执行。 */
  maxToolRounds?: number
}

const FALLBACK_TEMPLATE: AbilityTemplate = {
  id: 'readonly',
  name: '只读助手',
  description: '读取工作区信息并整理结果，不修改文件。',
  prompt: '读取必要信息并用结构化结论回答。',
  allowedTools: ['ls', 'read', 'grep']
}

type Route =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | { kind: 'create'; step: 1 | 2; templateId: AbilityTemplate['id']; idTouched: boolean }

function createDraft(
  name: string,
  template: AbilityTemplate,
  takenIds: Iterable<string>,
  location: SubagentPresetLocation = 'global'
): SubagentPresetDraft {
  return {
    location,
    preset: {
      id: generateSubagentPresetId(name || '新子代理', takenIds),
      name,
      description: template.description,
      enabled: true,
      allowedTools: [...template.allowedTools],
      prompt: template.prompt,
      ...(template.maxToolRounds !== undefined
        ? { maxToolRounds: template.maxToolRounds }
        : {})
    }
  }
}

function itemDraft(item: SubagentListItem): SubagentPresetDraft {
  return {
    location: item.origin === 'project' ? 'project' : 'global',
    preset: {
      id: item.id,
      name: item.name,
      description: item.description,
      enabled: item.enabled,
      allowedTools: [...item.allowedTools],
      prompt: item.prompt,
      ...(item.model ? { model: { ...item.model } } : {}),
      ...(item.maxToolRounds !== undefined ? { maxToolRounds: item.maxToolRounds } : {}),
      ...(item.contextWindow !== undefined ? { contextWindow: item.contextWindow } : {})
    }
  }
}

function validateDraft(
  draft: SubagentPresetDraft,
  canUseProject: boolean,
  items: readonly SubagentListItem[],
  registry: LlmRegistry | null,
  editingId?: string,
  checkDuplicate = true
): SubagentFieldErrors {
  const errors: SubagentFieldErrors = {}
  if (!draft.preset.name.trim()) errors.name = '请输入显示名称。'
  if (!isValidSubagentPresetId(draft.preset.id)) {
    errors.id = 'ID 需为 1–64 位小写字母、数字、点、下划线或连字符，且首尾为字母或数字。'
  } else if (checkDuplicate && items.some(item =>
    item.id === draft.preset.id &&
    item.id !== editingId &&
    item.origin === draft.location
  )) {
    errors.id = '当前保存范围已存在相同 ID。'
  }
  if (!draft.preset.description.trim()) errors.description = '请说明适用场景。'
  if (!draft.preset.prompt.trim()) errors.prompt = 'System prompt 不能为空。'
  if (draft.preset.allowedTools.length === 0) errors.allowedTools = '请至少选择一个工具。'
  if (
    draft.preset.maxToolRounds !== undefined &&
    (!Number.isInteger(draft.preset.maxToolRounds) || draft.preset.maxToolRounds < 1 || draft.preset.maxToolRounds > 1000)
  ) {
    errors.maxToolRounds = '最大工具轮数需为 1–1000 的整数。'
  }
  if (
    draft.preset.contextWindow !== undefined &&
    (!Number.isInteger(draft.preset.contextWindow) || draft.preset.contextWindow < 1)
  ) {
    errors.contextWindow = '上下文窗口需为正整数。'
  }
  if (draft.preset.model) {
    if (!('modelEntryId' in draft.preset.model)) {
      errors.model = '旧版模型引用不可保存，请重新选择模型。'
    } else {
      const binding = draft.preset.model
      const available = registry ? listSelectableModels(registry) : []
      const matched = available.find(model =>
        model.providerId === binding.providerId &&
        model.modelEntryId === binding.modelEntryId
      )
      if (!matched) {
        errors.model = '固定模型当前不可用，请重新选择或改为跟随默认模型。'
      } else if (binding.reasoningEffort && binding.reasoningEffort !== 'auto') {
        const entry = registry?.providers
          .find(provider => provider.id === binding.providerId)
          ?.models.find(item => item.id === binding.modelEntryId)
        const supported = entry ? getSupportedReasoningEfforts(entry) : null
        if (supported?.includes(binding.reasoningEffort) !== true) {
          errors.model = supported
            ? `该模型不支持 ${binding.reasoningEffort}，可选：${supported.join('、')}。`
            : '该模型的思考强度能力未知，请使用自动。'
        }
      }
    }
  }
  if (draft.location === 'project' && !canUseProject) errors.id = '保存项目配置前需要先打开工作区。'
  return errors
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <span className="subagent-form__error" role="alert">{message}</span>
}

export const SubagentsSettingsPanel: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const llmRegistry = useSettingsStore(state => state.llmRegistry)
  const [items, setItems] = useState<SubagentListItem[]>([])
  const [tools, setTools] = useState<SubagentToolOption[]>([])
  const [diagnostics, setDiagnostics] = useState<SubagentPresetDiagnostic[]>([])
  const [route, setRoute] = useState<Route>({ kind: 'list' })
  const [draft, setDraft] = useState<SubagentPresetDraft>(() =>
    createDraft('', FALLBACK_TEMPLATE, [])
  )
  const [fieldErrors, setFieldErrors] = useState<SubagentFieldErrors>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [actionId, setActionId] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const mountedRef = useRef(true)
  const loadGenerationRef = useRef(0)

  const selected = route.kind === 'detail'
    ? items.find(item => item.id === route.id) ?? null
    : null

  const loadList = useCallback(async (): Promise<SubagentListItem[] | null> => {
    const generation = ++loadGenerationRef.current
    if (mountedRef.current) setLoading(true)
    try {
      const result = await window.api.invoke('subagents:list', { workspaceRoot: currentProject })
      if (!mountedRef.current || generation !== loadGenerationRef.current) return null
      setItems(result.items)
      setDiagnostics(result.diagnostics)
      setTools(result.tools)
      return result.items
    } catch (error) {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setPageError(errorMessage(error, '加载子代理失败。'))
      }
      return null
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) setLoading(false)
    }
  }, [currentProject])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadGenerationRef.current += 1
    }
  }, [])

  useEffect(() => {
    void loadList().then(nextItems => {
      if (!nextItems) return
      setRoute(previous => {
        if (previous.kind === 'detail' && nextItems.some(item => item.id === previous.id)) return previous
        return nextItems[0] ? { kind: 'detail', id: nextItems[0].id } : { kind: 'list' }
      })
    })
  }, [loadList])

  useEffect(() => {
    if (selected && !selected.builtin) setDraft(itemDraft(selected))
    setFieldErrors({})
    setPageError(null)
    setDeleteConfirm(false)
  }, [selected?.id])

  const templates = useMemo<AbilityTemplate[]>(() => {
    const builtinTemplates = items
      .filter(item => item.builtin)
      .map(item => ({
        id: item.id,
        name: item.name,
        description: item.description,
        prompt: item.prompt,
        allowedTools: [...item.allowedTools],
        ...(item.maxToolRounds !== undefined ? { maxToolRounds: item.maxToolRounds } : {})
      }))
    return builtinTemplates.length > 0 ? builtinTemplates : [FALLBACK_TEMPLATE]
  }, [items])
  const template = route.kind === 'create'
    ? templates.find(candidate => candidate.id === route.templateId) ?? templates[0]
    : templates[0]

  const beginCreate = () => {
    const nextTemplate = templates[0]
    setDraft(createDraft('', nextTemplate, items.map(item => item.id)))
    setFieldErrors({})
    setPageError(null)
    setRoute({ kind: 'create', step: 1, templateId: nextTemplate.id, idTouched: false })
  }

  const selectTemplate = (templateId: AbilityTemplate['id']) => {
    const nextTemplate = templates.find(candidate => candidate.id === templateId) ?? templates[0]
    setDraft(current => ({
      ...current,
      preset: {
        ...current.preset,
        description: nextTemplate.description,
        prompt: nextTemplate.prompt,
        allowedTools: [...nextTemplate.allowedTools],
        maxToolRounds: nextTemplate.maxToolRounds
      }
    }))
    if (route.kind === 'create') setRoute({ ...route, templateId })
  }

  const continueCreate = () => {
    const errors = validateDraft(
      draft,
      Boolean(currentProject),
      items,
      llmRegistry,
      undefined,
      false
    )
    const firstStepErrors = { name: errors.name, id: errors.id, description: errors.description }
    if (Object.values(firstStepErrors).some(Boolean)) {
      setFieldErrors(firstStepErrors)
      return
    }
    if (route.kind === 'create') setRoute({ ...route, step: 2 })
  }

  const submitCreate = async () => {
    const errors = validateDraft(draft, Boolean(currentProject), items, llmRegistry)
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      return
    }
    setSaving(true)
    setPageError(null)
    try {
      const saved = await window.api.invoke('subagents:create', {
        preset: draft.preset,
        location: draft.location,
        workspaceRoot: currentProject
      })
      setItems(previous => [...previous.filter(item => item.id !== saved.id), saved])
      setDraft(itemDraft(saved))
      setRoute({ kind: 'detail', id: saved.id })
      await loadList()
    } catch (error) {
      const message = errorMessage(error, '创建失败，请检查输入后重试。')
      if (/同 ID|\.id/.test(message)) setFieldErrors(previous => ({ ...previous, id: message }))
      setPageError(message)
    } finally {
      setSaving(false)
    }
  }

  const submitUpdate = async () => {
    if (!selected || selected.builtin) return
    const errors = validateDraft(
      draft,
      Boolean(currentProject),
      items,
      llmRegistry,
      selected.id
    )
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      return
    }
    setSaving(true)
    setPageError(null)
    try {
      const saved = await window.api.invoke('subagents:update', {
        id: selected.id,
        preset: draft.preset,
        location: selected.origin === 'project' ? 'project' : 'global',
        workspaceRoot: currentProject
      })
      setItems(previous => previous.map(item => item.id === saved.id ? saved : item))
      setDraft(itemDraft(saved))
      await loadList()
    } catch (error) {
      setPageError(errorMessage(error, '保存失败，草稿已保留。'))
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = async (item: SubagentListItem, enabled: boolean) => {
    if (item.builtin) return
    setActionId(item.id)
    setPageError(null)
    try {
      const saved = await window.api.invoke('subagents:set-enabled', {
        id: item.id,
        enabled,
        location: item.origin === 'project' ? 'project' : 'global',
        workspaceRoot: currentProject
      })
      setItems(previous => previous.map(candidate => candidate.id === saved.id ? saved : candidate))
      if (route.kind === 'detail' && route.id === saved.id) setDraft(itemDraft(saved))
    } catch (error) {
      setPageError(errorMessage(error, '更新启用状态失败。'))
    } finally {
      setActionId(null)
    }
  }

  const deleteSelected = async () => {
    if (!selected || selected.builtin) return
    setSaving(true)
    setPageError(null)
    try {
      await window.api.invoke('subagents:delete', {
        id: selected.id,
        location: selected.origin === 'project' ? 'project' : 'global',
        workspaceRoot: currentProject
      })
      setRoute({ kind: 'list' })
      const nextItems = await loadList()
      if (nextItems?.[0]) setRoute({ kind: 'detail', id: nextItems[0].id })
    } catch (error) {
      setPageError(errorMessage(error, '删除失败。'))
    } finally {
      setSaving(false)
      setDeleteConfirm(false)
    }
  }

  const copyBuiltin = (item: SubagentListItem) => {
    const copyName = `${item.name} 副本`
    setDraft({
      location: 'global',
      preset: {
        ...itemDraft(item).preset,
        id: generateSubagentPresetId(copyName, items.map(candidate => candidate.id)),
        name: copyName
      }
    })
    setRoute({ kind: 'create', step: 2, templateId: item.id, idTouched: true })
    setFieldErrors({})
    setPageError(null)
  }

  const updateCreateDraft = (next: SubagentPresetDraft) => {
    setDraft(next)
    setFieldErrors({})
    setPageError(null)
  }

  return (
    <div className="settings-panel subagents-settings">
      <div className="settings-panel__toolbar">
        {route.kind !== 'list' && (
          <Button label="返回子代理列表" variant="ghost" size="sm" onClick={() => setRoute({ kind: 'list' })} isDisabled={saving}>
            返回列表
          </Button>
        )}
        <Button label="创建子代理" variant="primary" size="sm" onClick={beginCreate} isDisabled={saving}>
          创建子代理
        </Button>
      </div>

      {diagnostics.length > 0 && (
        <div className="subagent-diagnostics" role="alert">
          <strong>部分配置无法读取</strong>
          {diagnostics.map((diagnostic, index) => (
            <span key={`${diagnostic.location}-${diagnostic.code}-${index}`}>
              {diagnostic.location === 'project' ? '项目' : '全局'}：{diagnostic.message}
            </span>
          ))}
        </div>
      )}
      {pageError && <div className="settings-status settings-status--error subagent-page-error" role="alert">{pageError}</div>}

      <div className="settings-split subagent-workspace">
        <aside className="settings-split__list subagent-list" aria-label="子代理列表">
          {loading && <p className="settings-panel__muted">加载中…</p>}
          {!loading && items.length === 0 && (
            <div className="subagent-empty">
              <strong>还没有可用的子代理</strong>
              <span>从安全模板开始创建，之后可以继续调整模型和工具。</span>
              <Button label="创建第一个子代理" variant="secondary" size="sm" onClick={beginCreate}>开始创建</Button>
            </div>
          )}
          {items.map(item => (
            <div key={item.id} className={`subagent-list__row${selected?.id === item.id ? ' subagent-list__row--active' : ''}`}>
              <button
                type="button"
                aria-label={item.name}
                className="settings-split__item subagent-list__card"
                onClick={() => setRoute({ kind: 'detail', id: item.id })}
              >
                <span className="settings-split__item-title">{item.name}</span>
                <span className="settings-split__item-meta">
                  {item.builtin ? '内置' : item.origin === 'project' ? '项目' : '全局'}
                  {!item.enabled && ' · 已禁用'}
                </span>
              </button>
              {!item.builtin && (
                <Switch
                  label={`${item.enabled ? '禁用' : '启用'} ${item.name}`}
                  isLabelHidden
                  value={item.enabled}
                  onChange={enabled => void toggleEnabled(item, enabled)}
                  isDisabled={saving || actionId === item.id}
                />
              )}
            </div>
          ))}
        </aside>

        <main className="settings-split__editor subagent-editor">
          {route.kind === 'list' && items.length > 0 && (
            <div className="subagent-placeholder">
              <strong>选择一个子代理</strong>
              <span>查看真实能力，或编辑自定义配置。</span>
            </div>
          )}

          {route.kind === 'create' && route.step === 1 && (
            <div className="subagent-wizard">
              <header>
                <span>步骤 1 / 2</span>
                <h3>确定用途与身份</h3>
                <p>模板只生成安全初始值，下一步仍可逐项调整。</p>
              </header>
              <TextInput
                label="显示名称"
                value={draft.preset.name}
                onChange={name => {
                  const id = route.idTouched
                    ? draft.preset.id
                    : generateSubagentPresetId(name || '新子代理', items.map(item => item.id))
                  setDraft(current => ({ ...current, preset: { ...current.preset, name, id } }))
                  setFieldErrors({})
                }}
                placeholder="例如：依赖风险审查"
                isDisabled={saving}
                width="100%"
              />
              <FieldError message={fieldErrors.name} />
              <TextInput
                label="稳定 ID"
                description="创建前可以调整；创建后不可修改。"
                value={draft.preset.id}
                onChange={id => {
                  setDraft(current => ({ ...current, preset: { ...current.preset, id } }))
                  setRoute({ ...route, idTouched: true })
                  setFieldErrors({})
                }}
                isDisabled={saving}
                width="100%"
              />
              <FieldError message={fieldErrors.id} />
              <TextArea
                label="适用场景"
                value={draft.preset.description}
                onChange={description => setDraft(current => ({ ...current, preset: { ...current.preset, description } }))}
                isDisabled={saving}
                width="100%"
              />
              <FieldError message={fieldErrors.description} />
              <Selector
                label="能力模板"
                value={template.id}
                options={templates.map(candidate => ({ value: candidate.id, label: candidate.name }))}
                onChange={value => selectTemplate(value as AbilityTemplate['id'])}
                isDisabled={saving}
                width="100%"
              />
              <p className="settings-help">{template.description}</p>
              <footer className="subagent-actions">
                <Button label="取消创建" variant="secondary" onClick={() => setRoute({ kind: 'list' })}>取消</Button>
                <Button label="下一步" variant="primary" onClick={continueCreate}>下一步</Button>
              </footer>
            </div>
          )}

          {route.kind === 'create' && route.step === 2 && (
            <div className="subagent-detail-page">
              <header className="subagent-detail-header">
                <div>
                  <span>步骤 2 / 2</span>
                  <h3>检查配置</h3>
                  <p>保存失败不会清空当前输入。</p>
                </div>
              </header>
              <div className="subagent-detail-scroll">
                <SubagentPresetForm
                  draft={draft}
                  tools={tools}
                  registry={llmRegistry}
                  disabled={saving}
                  idEditable
                  canUseProject={Boolean(currentProject)}
                  fieldErrors={fieldErrors}
                  onChange={updateCreateDraft}
                />
              </div>
              <footer className="subagent-actions subagent-actions--sticky">
                <Button label="返回上一步" variant="secondary" onClick={() => setRoute({ ...route, step: 1 })} isDisabled={saving}>上一步</Button>
                <Button label={saving ? '创建中…' : '确认创建'} variant="primary" onClick={() => void submitCreate()} isDisabled={saving}>
                  {saving ? '创建中…' : '确认创建'}
                </Button>
              </footer>
            </div>
          )}

          {selected?.builtin && (
            <div className="subagent-detail-page">
              <header className="subagent-detail-header">
                <div>
                  <span>内置能力 · 只读</span>
                  <h3>{selected.name}</h3>
                  <p>{selected.description}</p>
                </div>
                <Button label="复制为自定义" variant="secondary" size="sm" onClick={() => copyBuiltin(selected)}>复制为自定义</Button>
              </header>
              <div className="subagent-detail-scroll">
                <section className="subagent-capability-summary">
                  <h4>模型策略</h4>
                  <p>{selected.model ? '使用固定模型绑定' : '派遣时跟随默认模型'}</p>
                  <h4>工具与权限</h4>
                  <div className="subagent-chip-list">{selected.allowedTools.map(tool => <code key={tool}>{tool}</code>)}</div>
                  <p>{selected.allowedTools.some(name => ['edit', 'write', 'bash', 'shell_session'].includes(name)) ? '最高可请求工作区写入权限' : '只读权限上限'}</p>
                  <h4>System prompt</h4>
                  <pre>{selected.prompt}</pre>
                  <h4>运行限制</h4>
                  <p>{selected.maxToolRounds !== undefined ? `最多 ${selected.maxToolRounds} 轮工具调用` : '工具调用轮数按权限档默认'}{selected.contextWindow ? ` · 上下文 ${selected.contextWindow} tokens` : ''}</p>
                </section>
              </div>
            </div>
          )}

          {selected && !selected.builtin && (
            <div className="subagent-detail-page">
              <header className="subagent-detail-header">
                <div>
                  <span>{selected.origin === 'project' ? '项目配置' : '全局配置'}</span>
                  <h3>{selected.name}</h3>
                  <p>ID：<code>{selected.id}</code></p>
                </div>
              </header>
              <div className="subagent-detail-scroll">
                <SubagentPresetForm
                  draft={draft}
                  tools={tools}
                  registry={llmRegistry}
                  disabled={saving}
                  showLocation={false}
                  fieldErrors={fieldErrors}
                  onChange={next => {
                    setDraft(next)
                    setFieldErrors({})
                    setPageError(null)
                  }}
                />
              </div>
              <footer className="subagent-actions subagent-actions--sticky">
                {deleteConfirm ? (
                  <div className="subagent-delete-confirm" role="alert">
                    <span>删除「{selected.name}」的{selected.origin === 'project' ? '项目' : '全局'}配置？</span>
                    <Button label="保留配置" variant="secondary" size="sm" onClick={() => setDeleteConfirm(false)} isDisabled={saving}>取消</Button>
                    <Button label="确认删除" variant="destructive" size="sm" onClick={() => void deleteSelected()} isDisabled={saving}>确认删除</Button>
                  </div>
                ) : (
                  <Button label="删除配置" variant="destructive" onClick={() => setDeleteConfirm(true)} isDisabled={saving}>删除</Button>
                )}
                <Button label={saving ? '保存中…' : '保存更改'} variant="primary" onClick={() => void submitUpdate()} isDisabled={saving}>
                  {saving ? '保存中…' : '保存更改'}
                </Button>
              </footer>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
