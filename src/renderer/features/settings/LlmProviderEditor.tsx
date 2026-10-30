/**
 * 单个服务商的行内编辑卡片：连接信息、模型目录与保存操作。
 * 只编辑父级传入的草稿，持久化由 LlmSettingsPanel 负责。
 */
import React, { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { TextInput } from '@astryxdesign/core/TextInput'
import { SettingsSelect } from './settingsKit'
import { LlmModelPicker } from './LlmModelPicker'
import { ChevronIcon, EyeOffIcon, PlusIcon, TrashIcon } from '../../components/Icons'
import {
  type ModelEntry,
  type ProviderConfig,
  type ReasoningEffort,
  generateLocalId,
  getSupportedReasoningEfforts,
  mergeFetchedModelEntries
} from '../../../shared/config/llmRegistry'
import { reasoningSelectionLabel } from '../../../shared/config/reasoning'

interface LlmProviderEditorProps {
  draft: ProviderConfig
  saving: boolean
  error: string | null
  closing?: boolean
  onChange: (next: ProviderConfig) => void
  onSave: () => void
  onCancel: () => void
}

/** 只有前若干行播入场动画，长列表不会同时挂上几十个动画 */
const ENTER_ANIMATED_ROWS = 10

type ToolDialect = NonNullable<ProviderConfig['toolDialect']>

const EyeIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const LlmProviderEditor: React.FC<LlmProviderEditorProps> = ({
  draft,
  saving,
  error,
  closing,
  onChange,
  onSave,
  onCancel
}) => {
  const [showKey, setShowKey] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(() => (draft.toolDialect ?? 'auto') !== 'auto')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const isPreset = Boolean(draft.presetId)
  const hasKey = draft.apiKey.trim().length > 0

  const updateModel = (modelEntryId: string, patch: Partial<ModelEntry>) =>
    onChange({
      ...draft,
      models: draft.models.map(m => (m.id === modelEntryId ? { ...m, ...patch } : m))
    })

  const removeModel = (modelEntryId: string) =>
    onChange({ ...draft, models: draft.models.filter(m => m.id !== modelEntryId) })

  const addManualModel = () => {
    const modelId = newModelId.trim()
    if (!modelId) return
    if (draft.models.some(m => m.modelId === modelId)) {
      setNotice('该模型已存在')
      return
    }
    onChange({ ...draft, models: [...draft.models, { id: generateLocalId('model'), modelId }] })
    setNewModelId('')
    setNotice(null)
  }

  const closeAddRow = () => {
    setAdding(false)
    setNewModelId('')
    setNotice(null)
  }

  return (
    <div className={`llm-editor${closing ? ' llm-editor--closing' : ''}`} aria-hidden={closing || undefined}>
      <div className="llm-editor__inner">
        <div className="llm-editor__content">
          <div className="llm-editor__fields">
            {!isPreset && (
              <TextInput
                label="名称"
                value={draft.name}
                onChange={value => onChange({ ...draft, name: value })}
                isDisabled={saving}
                width="100%"
              />
            )}

            {isPreset ? (
              <div className="llm-readonly">
                <span className="llm-readonly__label">接口地址</span>
                <code className="llm-readonly__value">{draft.baseUrl}</code>
              </div>
            ) : (
              <TextInput
                label="接口地址"
                value={draft.baseUrl}
                onChange={value => onChange({ ...draft, baseUrl: value })}
                placeholder="https://api.example.com/v1"
                isDisabled={saving}
                width="100%"
              />
            )}

            <div className="llm-key-field">
              <TextInput
                label="API 密钥"
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey}
                onChange={value => onChange({ ...draft, apiKey: value })}
                placeholder="填写后保存即可使用"
                isDisabled={saving}
                width="100%"
              />
              <IconButton
                label={showKey ? '隐藏 API 密钥' : '显示 API 密钥'}
                icon={showKey ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                variant="ghost"
                size="sm"
                className="llm-key-field__toggle"
                onClick={() => setShowKey(v => !v)}
              />
            </div>

            <div className="llm-advanced">
              <button
                type="button"
                className="llm-advanced__toggle"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen(v => !v)}
              >
                <ChevronIcon size={12} direction={advancedOpen ? 'down' : 'right'} />
                高级
              </button>
              {advancedOpen && (
                <div className="llm-advanced__body">
                  <span className="llm-field__label">工具调用方式</span>
                  <SettingsSelect
                    label="工具调用方式"
                    isLabelHidden
                    options={[
                      { value: 'auto', label: '自动（推荐）' },
                      { value: 'native', label: '原生函数调用' },
                      { value: 'xml', label: 'XML 兼容模式' }
                    ]}
                    value={draft.toolDialect ?? 'auto'}
                    onChange={value => onChange({ ...draft, toolDialect: value as ToolDialect })}
                    isDisabled={saving}
                    width={200}
                  />
                </div>
              )}
            </div>
          </div>

          <section className="llm-models" aria-label="模型">
            <header className="llm-models__header">
              <h4 className="llm-models__title">
                模型<span className="llm-models__count">{draft.models.length}</span>
              </h4>
              <Button
                label="获取可用模型"
                variant="secondary"
                size="sm"
                className="llm-glass-btn"
                onClick={() => setPickerOpen(true)}
                isDisabled={saving || !hasKey}
                tooltip={hasKey ? undefined : '请先填写 API 密钥'}
              >
                获取可用模型
              </Button>
            </header>

            <ul className="llm-models__list">
              {draft.models.map((entry, index) => (
                <ModelRow
                  key={entry.id}
                  entry={entry}
                  index={index}
                  disabled={saving}
                  expanded={expandedModelId === entry.id}
                  onToggle={() => setExpandedModelId(prev => (prev === entry.id ? null : entry.id))}
                  onUpdate={patch => updateModel(entry.id, patch)}
                  onRemove={() => removeModel(entry.id)}
                />
              ))}
              {draft.models.length === 0 && (
                <li className="llm-models__empty">还没有模型，获取可用模型或手动添加</li>
              )}
            </ul>

            {adding ? (
              <div className="llm-models__add-row">
                <TextInput
                  label="模型 ID"
                  isLabelHidden
                  value={newModelId}
                  onChange={value => { setNewModelId(value); setNotice(null) }}
                  placeholder="模型 ID，回车添加"
                  isDisabled={saving}
                  hasAutoFocus
                  width="100%"
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addManualModel()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      closeAddRow()
                    }
                  }}
                />
                <Button label="添加" variant="secondary" size="sm" onClick={addManualModel} isDisabled={saving || !newModelId.trim()}>
                  添加
                </Button>
                <Button label="收起" variant="ghost" size="sm" onClick={closeAddRow}>收起</Button>
              </div>
            ) : (
              <Button
                label="添加模型"
                variant="ghost"
                size="sm"
                icon={<PlusIcon size={13} />}
                className="llm-models__add"
                onClick={() => setAdding(true)}
                isDisabled={saving}
              >
                添加模型
              </Button>
            )}
            {notice && <p className="llm-editor__notice">{notice}</p>}
          </section>

          {error && <p className="llm-editor__error" role="alert">{error}</p>}

          <footer className="llm-editor__footer">
            <Button label="取消" variant="secondary" className="llm-glass-btn" onClick={onCancel} isDisabled={saving}>
              取消
            </Button>
            <Button
              label={saving ? '保存中…' : '保存'}
              variant="primary"
              className="llm-glass-btn llm-glass-btn--primary"
              onClick={onSave}
              isDisabled={saving}
            >
              {saving ? '保存中…' : '保存'}
            </Button>
          </footer>
        </div>
      </div>

      {pickerOpen && (
        <LlmModelPicker
          provider={draft}
          onClose={() => setPickerOpen(false)}
          onConfirm={modelIds => {
            onChange({ ...draft, models: mergeFetchedModelEntries(draft, modelIds) })
            setPickerOpen(false)
          }}
        />
      )}
    </div>
  )
}

const ModelRow: React.FC<{
  entry: ModelEntry
  index: number
  disabled: boolean
  expanded: boolean
  onToggle: () => void
  onUpdate: (patch: Partial<ModelEntry>) => void
  onRemove: () => void
}> = ({ entry, index, disabled, expanded, onToggle, onUpdate, onRemove }) => {
  const configuredEffort = entry.reasoningEffort ?? 'auto'
  const capabilityEfforts = getSupportedReasoningEfforts(entry)
  const supportedEfforts: readonly ReasoningEffort[] = capabilityEfforts
    ?? (configuredEffort !== 'auto' ? ['auto', configuredEffort] : ['auto'])
  const effortValue = supportedEfforts.includes(configuredEffort) ? configuredEffort : 'auto'

  const label = entry.displayName ?? entry.modelId
  const showId = Boolean(entry.displayName) && entry.displayName !== entry.modelId
  const vision = entry.supportsVision === undefined ? 'auto' : entry.supportsVision ? 'yes' : 'no'

  return (
    <li
      className={`llm-model-row${expanded ? ' llm-model-row--open' : ''}${index < ENTER_ANIMATED_ROWS ? ' llm-model-row--enter' : ''}`}
      style={{ '--i': index } as React.CSSProperties}
    >
      <div className="llm-model-row__head">
        <button
          type="button"
          className="llm-model-row__summary"
          aria-expanded={expanded}
          aria-label={`${expanded ? '收起' : '展开'} ${label} 的设置`}
          onClick={onToggle}
          disabled={disabled}
        >
          <span className="llm-model-row__name">{label}</span>
          {showId && <span className="llm-model-row__id">{entry.modelId}</span>}
          <ChevronIcon size={13} direction={expanded ? 'down' : 'right'} className="llm-model-row__chevron" />
        </button>
        <IconButton
          label={`移除 ${label}`}
          icon={<TrashIcon size={14} />}
          variant="ghost"
          size="sm"
          className="llm-model-row__remove"
          onClick={onRemove}
          isDisabled={disabled}
          tooltip="移除模型"
        />
      </div>

      {expanded && (
        <div className="llm-model-row__panel">
          <TextInput
            label="显示名"
            value={entry.displayName ?? ''}
            onChange={value => onUpdate({ displayName: value.trim() ? value : undefined })}
            placeholder="默认用模型 ID"
            isDisabled={disabled}
            width="100%"
          />
          <NumberInput
            label="上下文窗口"
            value={entry.contextWindow ?? null}
            onChange={value => onUpdate({ contextWindow: value ?? undefined })}
            placeholder="留空自动推断"
            min={1024}
            hasClear
            isDisabled={disabled}
            width="100%"
          />
          <div className="llm-model-row__field">
            <span className="llm-field__label">图片输入</span>
            <SegmentedControl
              label="图片输入"
              size="sm"
              value={vision}
              onChange={value => onUpdate({ supportsVision: value === 'auto' ? undefined : value === 'yes' })}
              isDisabled={disabled}
            >
              <SegmentedControlItem value="auto" label="自动" />
              <SegmentedControlItem value="yes" label="支持" />
              <SegmentedControlItem value="no" label="不支持" />
            </SegmentedControl>
          </div>
          <SettingsSelect
            label="推理强度"
            options={supportedEfforts.map(value => ({
              value,
              label: reasoningSelectionLabel(entry.modelId, value)
            }))}
            value={effortValue}
            onChange={value => onUpdate({ reasoningEffort: value as ReasoningEffort })}
            isDisabled={disabled || supportedEfforts.length === 1}
            width="100%"
          />
        </div>
      )}
    </li>
  )
}
