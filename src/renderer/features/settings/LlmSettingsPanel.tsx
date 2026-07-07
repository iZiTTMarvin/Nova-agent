/**
 * LLM 多服务商配置面板 — 左侧服务商列表 + 右侧详情
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSettingsStore, getDefaultLlmRegistry } from '../../stores/useSettingsStore'
import {
  type LlmRegistry,
  type ProviderConfig,
  type ModelEntry,
  type PresetProviderId,
  type ReasoningEffort,
  PRESET_PROVIDERS,
  PRESET_PROVIDER_IDS,
  findProviderByPreset,
  createProviderFromPreset,
  createCustomProvider,
  mergeFetchedModelEntries,
  resolveActiveModelAfterSave,
  generateLocalId
} from '../../../shared/config/llmRegistry'
import { ChevronIcon } from '../../components/Icons'

type Selection =
  | { kind: 'preset'; presetId: PresetProviderId }
  | { kind: 'custom'; providerId: string }

export const LlmSettingsPanel: React.FC = () => {
  const llmRegistry = useSettingsStore(state => state.llmRegistry)
  const saveLlmRegistry = useSettingsStore(state => state.saveLlmRegistry)
  const fetchProviderModels = useSettingsStore(state => state.fetchProviderModels)
  const setConfigModalOpen = useSettingsStore(state => state.setConfigModalOpen)

  const [draft, setDraft] = useState<LlmRegistry>(() => llmRegistry ?? getDefaultLlmRegistry())
  const [selection, setSelection] = useState<Selection>({ kind: 'preset', presetId: 'glm' })
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [newModelId, setNewModelId] = useState('')
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)

  useEffect(() => {
    if (llmRegistry) {
      setDraft(llmRegistry)
    }
  }, [llmRegistry])

  /**
   * 选中某个服务商时，确保它在 draft.providers 中存在一个稳定实例：
   * - 预设服务商：首次选中即落进 draft（enabled:false、空模型列表、稳定占位 id），
   *   避免后续 editingProvider 每次重算丢掉刷新拉取的真实模型。
   * - 自定义服务商：已由 handleAddCustomProvider 落进 draft，无需重复创建。
   *
   * 注意：落进 draft 只是草稿态，不写盘；只有 handleSave 才会真正持久化。
   * 用户取消时 draft 被丢弃，自然回退到磁盘真相。
   */
  useEffect(() => {
    setDraft(prev => {
      if (selection.kind === 'preset') {
        // 预设已在 draft 中 → 无需处理
        if (findProviderByPreset(prev, selection.presetId)) return prev
        const meta = PRESET_PROVIDERS[selection.presetId]
        const placeholder: ProviderConfig = {
          id: `preset-${selection.presetId}`,
          name: meta.name,
          presetId: selection.presetId,
          baseUrl: meta.baseUrl,
          apiKey: '',
          enabled: false,
          models: []
        }
        return { ...prev, providers: [...prev.providers, placeholder] }
      }
      // 自定义：若不存在则补一个空壳（理论上 handleAddCustomProvider 已处理）
      if (!prev.providers.some(p => p.id === selection.providerId)) {
        const created = createCustomProvider('自定义服务商', 'http://localhost:11434/v1')
        created.id = selection.providerId
        return { ...prev, providers: [...prev.providers, created] }
      }
      return prev
    })
  }, [selection])

  /** 当前编辑的服务商（始终从 draft 取，保证引用稳定） */
  const editingProvider = useMemo((): ProviderConfig | null => {
    if (selection.kind === 'preset') {
      return findProviderByPreset(draft, selection.presetId) ?? null
    }
    return draft.providers.find(p => p.id === selection.providerId) ?? null
  }, [draft, selection])

  const customProviders = useMemo(
    () => draft.providers.filter(p => !p.presetId),
    [draft.providers]
  )

  const updateProviderInDraft = useCallback((updated: ProviderConfig) => {
    setDraft(prev => {
      const idx = prev.providers.findIndex(
        p => p.id === updated.id || (updated.presetId && p.presetId === updated.presetId)
      )
      if (idx >= 0) {
        const providers = [...prev.providers]
        providers[idx] = updated
        return { ...prev, providers }
      }
      return { ...prev, providers: [...prev.providers, updated] }
    })
  }, [])

  const handlePresetSelect = (presetId: PresetProviderId) => {
    setSelection({ kind: 'preset', presetId })
    setSubmitError(null)
    setRefreshMessage(null)
  }

  const handleCustomSelect = (providerId: string) => {
    setSelection({ kind: 'custom', providerId })
    setSubmitError(null)
    setRefreshMessage(null)
  }

  const handleAddCustomProvider = () => {
    const provider = createCustomProvider('自定义服务商', 'http://localhost:11434/v1')
    setDraft(prev => ({
      ...prev,
      providers: [...prev.providers, provider]
    }))
    setSelection({ kind: 'custom', providerId: provider.id })
  }

  const handleRemoveCustomProvider = (providerId: string) => {
    setDraft(prev => {
      const providers = prev.providers.filter(p => p.id !== providerId)
      const nextActive =
        prev.activeModel.providerId === providerId && providers.length > 0
          ? {
              providerId: providers[0].id,
              modelEntryId: providers[0].models[0]?.id ?? prev.activeModel.modelEntryId
            }
          : prev.activeModel
      return { ...prev, providers, activeModel: nextActive }
    })
    if (selection.kind === 'custom' && selection.providerId === providerId) {
      setSelection({ kind: 'preset', presetId: 'glm' })
    }
  }

  const handleRefreshModels = async () => {
    if (!editingProvider) return
    if (!editingProvider.apiKey.trim()) {
      setRefreshMessage('请先填写 API Key')
      return
    }
    setRefreshing(true)
    setRefreshMessage(null)
    try {
      const result = await fetchProviderModels(editingProvider.baseUrl, editingProvider.apiKey)
      if (!result.ok) {
        setRefreshMessage(result.message)
        return
      }
      const merged = mergeFetchedModelEntries(editingProvider, result.modelIds)
      updateProviderInDraft({ ...editingProvider, models: merged, enabled: true })
      setRefreshMessage(`已合并 ${result.modelIds.length} 个模型`)
    } finally {
      setRefreshing(false)
    }
  }

  const handleAddModel = () => {
    if (!editingProvider || !newModelId.trim()) return
    const trimmed = newModelId.trim()
    if (editingProvider.models.some(m => m.modelId === trimmed)) {
      setRefreshMessage('该模型已存在')
      return
    }
    updateProviderInDraft({
      ...editingProvider,
      models: [
        ...editingProvider.models,
        { id: generateLocalId('model'), modelId: trimmed }
      ]
    })
    setNewModelId('')
    setRefreshMessage(null)
  }

  const handleRemoveModel = (modelEntryId: string) => {
    if (!editingProvider) return
    updateProviderInDraft({
      ...editingProvider,
      models: editingProvider.models.filter(m => m.id !== modelEntryId)
    })
  }

  /** 更新单个模型条目的字段（供高级配置区使用） */
  const handleUpdateModel = (modelEntryId: string, patch: Partial<ModelEntry>) => {
    if (!editingProvider) return
    updateProviderInDraft({
      ...editingProvider,
      models: editingProvider.models.map(m =>
        m.id === modelEntryId ? { ...m, ...patch } : m
      )
    })
  }

  const handleSave = async () => {
    if (!editingProvider) return

    if (!editingProvider.apiKey.trim()) {
      setSubmitError('请填写 API Key')
      return
    }
    if (editingProvider.models.length === 0) {
      setSubmitError('请至少添加一个模型')
      return
    }

    // 自定义服务商首次保存时生成稳定正式 id；预设服务商沿用占位 id `preset-<id>`
    const stableId = editingProvider.presetId
      ? editingProvider.id
      : draft.providers.some(p => p.id === editingProvider.id && p.apiKey.trim())
        ? editingProvider.id
        : generateLocalId('custom')

    const toSave: ProviderConfig = {
      ...editingProvider,
      id: stableId,
      apiKey: editingProvider.apiKey.trim(),
      baseUrl: editingProvider.baseUrl.trim(),
      enabled: true
    }

    const nextProviders = [...draft.providers]
    const existIdx = nextProviders.findIndex(
      p => p.id === toSave.id || (toSave.presetId && p.presetId === toSave.presetId)
    )
    if (existIdx >= 0) {
      nextProviders[existIdx] = toSave
    } else {
      nextProviders.push(toSave)
    }

    // 计算 activeModel：当前 active 失效（首次配置为空 / 引用的 provider 不存在）
    // 或正指向本次保存的服务商时，锚定到 toSave；否则保持不变。
    const activeModel = resolveActiveModelAfterSave(draft.activeModel, toSave, nextProviders)

    const nextRegistry: LlmRegistry = {
      ...draft,
      providers: nextProviders,
      activeModel
    }

    setSaving(true)
    setSubmitError(null)
    try {
      await saveLlmRegistry(nextRegistry)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const isPresetConnected = (presetId: PresetProviderId) => {
    const p = findProviderByPreset(draft, presetId)
    return Boolean(p?.apiKey.trim() && p.enabled)
  }

  if (!editingProvider) {
    return (
      <div className="settings-panel">
        <header className="settings-panel__header">
          <h3 className="settings-panel__title">LLM 配置</h3>
        </header>
        <div className="settings-panel__scroll">加载中…</div>
      </div>
    )
  }

  return (
    <div className="settings-panel">
      <header className="settings-panel__header settings-panel__header--row">
        <div>
          <h3 className="settings-panel__title">LLM 配置</h3>
          <p className="settings-panel__desc">
            按服务商管理 API Key 与模型，可在对话框底部快速切换。
          </p>
        </div>
      </header>

      <div className="settings-split llm-settings-split">
        {/* 左侧：服务商列表（与规则/子代理面板同款列表样式） */}
        <div className="settings-split__list llm-provider-list">
          <div className="llm-provider-list__section-title">预设服务商</div>
          {PRESET_PROVIDER_IDS.map(presetId => {
            const meta = PRESET_PROVIDERS[presetId]
            const connected = isPresetConnected(presetId)
            const isActive =
              selection.kind === 'preset' && selection.presetId === presetId
            return (
              <button
                key={presetId}
                type="button"
                className={`settings-split__item${isActive ? ' settings-split__item--active' : ''}`}
                onClick={() => handlePresetSelect(presetId)}
              >
                <span className="settings-split__item-title">{meta.name}</span>
                <span
                  className={`settings-split__item-meta${
                    connected ? ' llm-provider-card__status--ok' : ''
                  }`}
                >
                  {connected ? '已连接' : '未连接'}
                </span>
              </button>
            )
          })}

          <div className="llm-provider-list__section-title">自定义</div>
          {customProviders.length === 0 && (
            <p className="llm-provider-list__empty-hint">暂无自定义服务商</p>
          )}
          {customProviders.map(p => {
            const isActive = selection.kind === 'custom' && selection.providerId === p.id
            return (
              <button
                key={p.id}
                type="button"
                className={`settings-split__item${isActive ? ' settings-split__item--active' : ''}`}
                onClick={() => handleCustomSelect(p.id)}
              >
                <span className="settings-split__item-title">{p.name}</span>
                <span
                  className={`settings-split__item-meta${
                    p.apiKey.trim() ? ' llm-provider-card__status--ok' : ''
                  }`}
                >
                  {p.apiKey.trim() ? '已连接' : '未连接'}
                </span>
              </button>
            )
          })}

          <button
            type="button"
            className="llm-provider-add"
            onClick={handleAddCustomProvider}
          >
            + 添加自定义服务商
          </button>
        </div>

        {/* 右侧：服务商详情 */}
        <div className="settings-split__editor llm-provider-detail">
          <div className="llm-provider-detail__scroll">
            {selection.kind === 'custom' && (
              <div className="llm-provider-detail__toolbar">
                <div className="settings-modal__field llm-provider-detail__name-field">
                  <label className="settings-modal__label">服务商名称</label>
                  <input
                    type="text"
                    className="settings-modal__input"
                    value={editingProvider.name}
                    onChange={e =>
                      updateProviderInDraft({ ...editingProvider, name: e.target.value })
                    }
                    disabled={saving}
                  />
                </div>
                <button
                  type="button"
                  className="settings-modal__btn settings-modal__btn--cancel llm-provider-detail__remove"
                  onClick={() => handleRemoveCustomProvider(editingProvider.id)}
                >
                  删除
                </button>
              </div>
            )}

            <div className="settings-modal__field">
            <label className="settings-modal__label">接口地址 (Base URL)</label>
            <input
              type="text"
              className="settings-modal__input"
              value={editingProvider.baseUrl}
              onChange={e =>
                updateProviderInDraft({ ...editingProvider, baseUrl: e.target.value })
              }
              readOnly={Boolean(editingProvider.presetId)}
              disabled={saving || Boolean(editingProvider.presetId)}
            />
            {editingProvider.presetId && (
              <span className="settings-modal__help">预设服务商地址不可修改。</span>
            )}
          </div>

          <div className="settings-modal__field">
            <label className="settings-modal__label">API Key</label>
            <div className="settings-modal__input-wrapper">
              <input
                type={showKey ? 'text' : 'password'}
                className="settings-modal__input settings-modal__input--password"
                value={editingProvider.apiKey}
                onChange={e =>
                  updateProviderInDraft({ ...editingProvider, apiKey: e.target.value })
                }
                placeholder="填写后保存即可使用"
                disabled={saving}
              />
              <button
                type="button"
                className="settings-modal__toggle-pwd"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
          </div>

          <div className="settings-modal__field">
            <label className="settings-modal__label">工具调用方式</label>
            <select
              className="settings-modal__input settings-modal__select"
              value={editingProvider.toolDialect ?? 'auto'}
              onChange={e =>
                updateProviderInDraft({
                  ...editingProvider,
                  toolDialect: e.target.value as 'auto' | 'native' | 'xml'
                })
              }
              disabled={saving}
            >
              <option value="auto">自动（推荐）</option>
              <option value="native">原生函数调用</option>
              <option value="xml">XML 兼容模式</option>
            </select>
          </div>

          <div className="settings-modal__field">
            <div className="llm-model-list__toolbar">
              <label className="settings-modal__label">模型列表</label>
              <button
                type="button"
                className="settings-modal__btn settings-modal__btn--cancel llm-model-refresh"
                onClick={() => void handleRefreshModels()}
                disabled={saving || refreshing || !editingProvider.apiKey.trim()}
                title={
                  editingProvider.apiKey.trim()
                    ? '从服务商拉取可用模型'
                    : '请先填写 API Key'
                }
              >
                {refreshing ? '刷新中…' : '刷新模型列表'}
              </button>
            </div>
            {refreshMessage && (
              <span className="settings-modal__help">{refreshMessage}</span>
            )}

            <ul className="llm-model-list">
              {editingProvider.models.map(entry => (
                <ModelEntryRow
                  key={entry.id}
                  entry={entry}
                  disabled={saving}
                  onUpdate={patch => handleUpdateModel(entry.id, patch)}
                  onRemove={() => handleRemoveModel(entry.id)}
                />
              ))}
              {editingProvider.models.length === 0 && (
                <li className="llm-model-list__empty">
                  {editingProvider.apiKey.trim()
                    ? '暂无模型，请点击「刷新模型列表」获取，或手动添加'
                    : '请先填写 API Key，再点击「刷新模型列表」获取可用模型'}
                </li>
              )}
            </ul>

            <div className="llm-model-add">
              <input
                type="text"
                className="settings-modal__input"
                value={newModelId}
                onChange={e => setNewModelId(e.target.value)}
                placeholder="手动输入模型 ID"
                disabled={saving}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleAddModel()
                  }
                }}
              />
              <button
                type="button"
                className="settings-modal__btn settings-modal__btn--cancel"
                onClick={handleAddModel}
                disabled={saving || !newModelId.trim()}
              >
                添加
              </button>
            </div>
          </div>

          {submitError && <div className="settings-modal__error">{submitError}</div>}
          </div>

          <div className="settings-modal__actions llm-provider-detail__actions">
            <button
              type="button"
              className="settings-modal__btn settings-modal__btn--cancel"
              onClick={() => setConfigModalOpen(false)}
              disabled={saving}
            >
              取消
            </button>
            <button
              type="button"
              className="settings-modal__btn settings-modal__btn--save"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存配置'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 单个模型条目行 —— 名称 + 移除 + 可折叠「高级配置」区。
 * 高级区默认收起，包含：显示名 / 上下文窗口 / 思考强度 / 支持图片。
 */
const ModelEntryRow: React.FC<{
  entry: ModelEntry
  disabled: boolean
  onUpdate: (patch: Partial<ModelEntry>) => void
  onRemove: () => void
}> = ({ entry, disabled, onUpdate, onRemove }) => {
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const label = entry.displayName ?? entry.modelId
  const showId = entry.displayName && entry.displayName !== entry.modelId

  return (
    <li className="llm-model-list__item">
      <div className="llm-model-list__row">
        <div className="llm-model-list__info">
          <span className="llm-model-list__name">{label}</span>
          {showId && (
            <span className="llm-model-list__id">{entry.modelId}</span>
          )}
        </div>
        <div className="llm-model-list__actions">
          {/* 高级标记：已配置过高级项时给出视觉提示 */}
          {advancedOpen && (
            <span className="llm-model-list__badge" title="已展开高级配置">高级</span>
          )}
          <button
            type="button"
            className="llm-model-list__advanced-toggle"
            onClick={() => setAdvancedOpen(!advancedOpen)}
            disabled={disabled}
            title="高级配置"
            aria-expanded={advancedOpen}
            aria-label={`高级配置 ${label}`}
          >
            <ChevronIcon size={14} direction={advancedOpen ? 'up' : 'down'} />
          </button>
          <button
            type="button"
            className="llm-model-list__remove"
            onClick={onRemove}
            disabled={disabled}
            title="移除模型"
            aria-label={`移除 ${label}`}
          >
            ×
          </button>
        </div>
      </div>

      {advancedOpen && (
        <div className="llm-model-list__advanced">
          <div className="settings-modal__field">
            <label className="settings-modal__label">显示名</label>
            <input
              type="text"
              className="settings-modal__input"
              value={entry.displayName ?? ''}
              onChange={e =>
                onUpdate(e.target.value.trim() ? { displayName: e.target.value } : { displayName: undefined })
              }
              placeholder="默认用模型 ID"
              disabled={disabled}
            />
          </div>

          <div className="settings-modal__field">
            <label className="settings-modal__label">上下文窗口（tokens）</label>
            <input
              type="number"
              className="settings-modal__input"
              value={entry.contextWindow ?? ''}
              onChange={e => {
                const v = e.target.value
                onUpdate(v === '' ? { contextWindow: undefined } : { contextWindow: Number(v) })
              }}
              placeholder="留空则自动推断"
              min={1024}
              disabled={disabled}
            />
            <span className="settings-modal__help">如 128000；留空时按模型 ID 猜测。</span>
          </div>

          <div className="settings-modal__field">
            <label className="settings-modal__label">思考强度</label>
            <select
              className="settings-modal__input settings-modal__select"
              value={entry.reasoningEffort ?? 'auto'}
              onChange={e =>
                onUpdate({ reasoningEffort: e.target.value as ReasoningEffort })
              }
              disabled={disabled}
            >
              <option value="auto">自动（推荐，不发送参数）</option>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
            <span className="settings-modal__help">控制推理深度；auto 不影响现有行为。</span>
          </div>

          <div className="settings-modal__field">
            <label className="settings-modal__label">支持图片</label>
            <select
              className="settings-modal__input settings-modal__select"
              value={
                entry.supportsVision === undefined
                  ? 'auto'
                  : entry.supportsVision
                    ? 'yes'
                    : 'no'
              }
              onChange={e => {
                const v = e.target.value
                onUpdate({
                  supportsVision: v === 'auto' ? undefined : v === 'yes'
                })
              }}
              disabled={disabled}
            >
              <option value="auto">自动（留空）</option>
              <option value="yes">是</option>
              <option value="no">否</option>
            </select>
          </div>
        </div>
      )}
    </li>
  )
}
