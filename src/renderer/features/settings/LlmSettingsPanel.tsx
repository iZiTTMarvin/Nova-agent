/**
 * LLM 服务商配置面板：服务商列表，点击后在原位展开编辑卡片。
 * 每次只编辑一个服务商，保存只写入该服务商；后台任务模型独立保存。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { useSettingsStore, getDefaultLlmRegistry } from '../../stores/useSettingsStore'
import { SettingsSelect } from './settingsKit'
import { LlmProviderEditor } from './LlmProviderEditor'
import { useSettingsUnsavedGuard } from './settingsUnsavedGuard'
import { ChevronIcon, PlusIcon } from '../../components/Icons'
import {
  type LlmRegistry,
  type PresetProviderId,
  type ProviderConfig,
  PRESET_PROVIDERS,
  PRESET_PROVIDER_IDS,
  createCustomProvider,
  findProviderByPreset,
  listSelectableModels,
  removeProviderFromRegistry,
  resolveActiveModelAfterSave
} from '../../../shared/config/llmRegistry'
import './LlmSettingsPanel.css'

const FOLLOW_ACTIVE_MODEL = 'follow-active'
const DEFAULT_CUSTOM_BASE_URL = 'http://localhost:11434/v1'

interface ProviderRowModel {
  key: string
  name: string
  provider: ProviderConfig | null
  presetId?: PresetProviderId
}

interface EditingState {
  rowKey: string
  draft: ProviderConfig
  /** 打开编辑时的草稿快照，用于判定是否有未保存修改 */
  initial: ProviderConfig
  isNew: boolean
  /** 折叠动画进行中：卡片仍挂载，播完再卸载 */
  closing?: boolean
}

/** 与 LlmSettingsPanel.css 中 llm-fold 的时长一致 */
const FOLD_MS = 160

function toModelOptionValue(ref: { providerId: string; modelEntryId: string }): string {
  return `${ref.providerId}::${ref.modelEntryId}`
}

/** 主进程校验错误经 IPC 会带上调用前缀，展示前去掉 */
function describeError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : ''
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || fallback
}

function draftForRow(row: ProviderRowModel): ProviderConfig {
  if (row.provider) return { ...row.provider }
  const meta = PRESET_PROVIDERS[row.presetId!]
  return {
    id: `preset-${meta.presetId}`,
    name: meta.name,
    presetId: meta.presetId,
    baseUrl: meta.baseUrl,
    apiKey: '',
    enabled: false,
    models: []
  }
}

export const LlmSettingsPanel: React.FC = () => {
  const llmRegistry = useSettingsStore(state => state.llmRegistry)
  const saveLlmRegistry = useSettingsStore(state => state.saveLlmRegistry)
  const registry = useMemo<LlmRegistry>(() => llmRegistry ?? getDefaultLlmRegistry(), [llmRegistry])

  const [editing, setEditing] = useState<EditingState | null>(null)
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmingRemoveKey, setConfirmingRemoveKey] = useState<string | null>(null)
  const [savedKey, setSavedKey] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  const rows = useMemo<ProviderRowModel[]>(
    () => [
      ...PRESET_PROVIDER_IDS.map(presetId => {
        const provider = findProviderByPreset(registry, presetId) ?? null
        return {
          key: provider?.id ?? `preset:${presetId}`,
          name: PRESET_PROVIDERS[presetId].name,
          provider,
          presetId
        }
      }),
      ...registry.providers
        .filter(p => !p.presetId)
        .map(p => ({ key: p.id, name: p.name, provider: p }))
    ],
    [registry]
  )

  const backgroundModelOptions = useMemo(
    () => [
      { value: FOLLOW_ACTIVE_MODEL, label: '跟随当前模型' },
      ...listSelectableModels(registry).map(model => ({
        value: toModelOptionValue(model),
        label: `${model.providerName} / ${model.displayName}`
      }))
    ],
    [registry]
  )

  /** 写入注册表；成功返回 null，失败返回可展示的错误文案 */
  const persist = async (next: LlmRegistry): Promise<string | null> => {
    setSaving(true)
    try {
      await saveLlmRegistry(next)
      return null
    } catch (err) {
      return describeError(err, '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const foldTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(foldTimer.current), [])

  /** 先播折叠动画再卸载编辑卡片；减弱动态时直接卸载 */
  const closeEditor = () => {
    window.clearTimeout(foldTimer.current)
    setSubmitError(null)
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setEditing(null)
      return
    }
    setEditing(cur => (cur ? { ...cur, closing: true } : cur))
    foldTimer.current = window.setTimeout(() => setEditing(null), FOLD_MS)
  }

  const beginEditing = (next: EditingState) => {
    window.clearTimeout(foldTimer.current)
    setEditing(next)
    setSubmitError(null)
    setListError(null)
    setConfirmingRemoveKey(null)
  }

  const startEdit = (row: ProviderRowModel) => {
    const draft = draftForRow(row)
    beginEditing({ rowKey: row.key, draft, initial: draft, isNew: false })
  }

  const startAddCustom = () => {
    const draft = createCustomProvider('自定义服务商', DEFAULT_CUSTOM_BASE_URL)
    beginEditing({ rowKey: draft.id, draft, initial: draft, isNew: true })
  }

  // 折叠中的卡片已放弃编辑；JSON 比较足够，偶发的键序差异只会多问一次
  const editorDirty = Boolean(
    editing && !editing.closing && JSON.stringify(editing.draft) !== JSON.stringify(editing.initial)
  )
  useSettingsUnsavedGuard('llm', editorDirty)

  const toggleRow = (row: ProviderRowModel, isEditing: boolean) => {
    if (saving) return
    if (!isEditing) startEdit(row)
    else if (!editing?.closing) closeEditor()
  }

  const handleSave = async () => {
    if (!editing) return
    const { draft } = editing
    const baseUrl = draft.baseUrl.trim()
    if (!draft.name.trim()) return setSubmitError('请填写服务商名称')
    if (!/^https?:\/\/.+/.test(baseUrl)) return setSubmitError('接口地址需以 http:// 或 https:// 开头')
    if (!draft.apiKey.trim()) return setSubmitError('请填写 API 密钥')
    if (draft.models.length === 0) return setSubmitError('请至少添加一个模型')

    const toSave: ProviderConfig = {
      ...draft,
      name: draft.name.trim(),
      apiKey: draft.apiKey.trim(),
      baseUrl,
      enabled: true
    }
    const providers = [...registry.providers]
    const existIdx = providers.findIndex(
      p => p.id === toSave.id || (toSave.presetId && p.presetId === toSave.presetId)
    )
    if (existIdx >= 0) providers[existIdx] = toSave
    else providers.push(toSave)

    setSubmitError(null)
    const error = await persist({
      ...registry,
      providers,
      activeModel: resolveActiveModelAfterSave(registry.activeModel, toSave, providers)
    })
    if (error) return setSubmitError(error)
    closeEditor()
    setSavedKey(toSave.id)
  }

  const handleRemove = async (providerId: string) => {
    setConfirmingRemoveKey(null)
    setListError(await persist(removeProviderFromRegistry(registry, providerId)))
  }

  const handleBackgroundModelChange = async (value: string) => {
    const next: LlmRegistry = { ...registry }
    const picked = listSelectableModels(registry).find(m => toModelOptionValue(m) === value)
    if (picked) next.backgroundModel = { providerId: picked.providerId, modelEntryId: picked.modelEntryId }
    else delete next.backgroundModel
    setListError(await persist(next))
  }

  const renderEditor = () =>
    editing && (
      <LlmProviderEditor
        draft={editing.draft}
        saving={saving}
        error={submitError}
        onChange={draft => {
          setEditing({ ...editing, draft })
          setSubmitError(null)
        }}
        closing={editing.closing}
        onSave={() => void handleSave()}
        onCancel={closeEditor}
      />
    )

  const renderCollapseButton = (name: string, closing: boolean) => (
    <IconButton
      label={`收起 ${name}`}
      icon={<ChevronIcon size={14} direction={closing ? 'down' : 'up'} />}
      variant="ghost"
      size="sm"
      className="llm-row__collapse"
      onClick={closeEditor}
    />
  )

  return (
    <div className="settings-panel llm-panel">
      <div className="llm-panel__aurora" aria-hidden="true" />

      <div className="llm-panel__scroll">
        <div className="llm-panel__column">
          <ul className="llm-list" aria-label="模型服务商">
            {rows.map(row => {
              const { provider } = row
              const configured = Boolean(provider?.apiKey.trim() && provider.enabled)
              const isEditing = editing?.rowKey === row.key
              const isCurrent = Boolean(provider) && registry.activeModel.providerId === provider!.id
              const confirming = confirmingRemoveKey === row.key
              const isCustom = !row.presetId
              return (
                <li
                  key={row.key}
                  className={`llm-row${isEditing && !editing?.closing ? ' llm-row--open' : ''}${savedKey === provider?.id ? ' llm-row--saved' : ''}`}
                  onAnimationEnd={e => {
                    if (e.animationName === 'llm-saved-sweep') setSavedKey(null)
                  }}
                >
                  <div
                    className="llm-row__head"
                    onClick={() => toggleRow(row, isEditing)}
                  >
                    {/* 整行可点只为扩大鼠标命中区；键盘与读屏走标题按钮，避免可交互元素嵌套 */}
                    <button
                      type="button"
                      className="llm-row__title"
                      aria-expanded={isEditing && !editing?.closing}
                      disabled={saving}
                      onClick={e => {
                        e.stopPropagation()
                        toggleRow(row, isEditing)
                      }}
                    >
                      <span
                        className={`llm-dot${configured ? ' llm-dot--ok' : ''}`}
                        role="img"
                        aria-label={configured ? '已配置' : '未配置'}
                      />
                      <span className="llm-row__name">{row.name}</span>
                      {isCustom && <span className="llm-tag">自定义</span>}
                      {isCurrent && <span className="llm-tag llm-tag--current">当前使用</span>}
                    </button>
                    <div className="llm-row__aside" onClick={e => e.stopPropagation()}>
                      {provider && provider.models.length > 0 && (
                        <span className="llm-row__count">{provider.models.length} 个模型</span>
                      )}
                      {isEditing ? (
                        renderCollapseButton(row.name, Boolean(editing?.closing))
                      ) : confirming ? (
                        <>
                          <Button label="取消删除" variant="ghost" size="sm" onClick={() => setConfirmingRemoveKey(null)}>
                            取消
                          </Button>
                          <Button
                            label={`确认删除 ${row.name}`}
                            variant="destructive"
                            size="sm"
                            onClick={() => void handleRemove(provider!.id)}
                            isDisabled={saving}
                          >
                            确认删除
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            label={configured || provider ? `编辑 ${row.name}` : `配置 ${row.name}`}
                            variant="secondary"
                            size="sm"
                            className="llm-glass-btn"
                            onClick={() => startEdit(row)}
                            isDisabled={saving}
                          >
                            {provider ? '编辑' : '配置'}
                          </Button>
                          {isCustom && provider && (
                            <Button
                              label={`删除 ${row.name}`}
                              variant="ghost"
                              size="sm"
                              className="llm-row__remove"
                              onClick={() => setConfirmingRemoveKey(row.key)}
                              isDisabled={saving}
                            >
                              删除
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  {isEditing && renderEditor()}
                </li>
              )
            })}

            {editing?.isNew ? (
              <li className={`llm-row${editing.closing ? '' : ' llm-row--open'}`}>
                <div className="llm-row__head" onClick={() => !editing.closing && closeEditor()}>
                  <button
                    type="button"
                    className="llm-row__title"
                    aria-expanded={!editing.closing}
                    onClick={e => {
                      e.stopPropagation()
                      if (!editing.closing) closeEditor()
                    }}
                  >
                    <span className="llm-dot" role="img" aria-label="未配置" />
                    <span className="llm-row__name">新服务商</span>
                    <span className="llm-tag">自定义</span>
                  </button>
                  <div className="llm-row__aside" onClick={e => e.stopPropagation()}>
                    {renderCollapseButton('新服务商', Boolean(editing.closing))}
                  </div>
                </div>
                {renderEditor()}
              </li>
            ) : (
              <li className="llm-add-wrap">
                <button
                  type="button"
                  className="llm-add"
                  onClick={startAddCustom}
                  disabled={saving}
                >
                  <PlusIcon size={14} />
                  添加自定义服务商
                </button>
              </li>
            )}
          </ul>

          {listError && <p className="llm-panel__error" role="alert">{listError}</p>}

          <div className="llm-background">
            <div className="llm-background__text">
              <span className="llm-background__label">后台任务模型</span>
              <span className="llm-background__hint">记忆提炼与主题整理</span>
            </div>
            <SettingsSelect
              label="后台任务模型"
              isLabelHidden
              options={backgroundModelOptions}
              value={registry.backgroundModel ? toModelOptionValue(registry.backgroundModel) : FOLLOW_ACTIVE_MODEL}
              onChange={value => void handleBackgroundModelChange(value)}
              isDisabled={saving}
              width={240}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
