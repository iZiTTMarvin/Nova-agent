import React, { useMemo } from 'react'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { Selector } from '@astryxdesign/core/Selector'
import { Switch } from '@astryxdesign/core/Switch'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import {
  getActiveModelDisplayName,
  listSelectableModels,
  type LlmRegistry,
  type ReasoningEffort
} from '../../../shared/config/llmRegistry'
import type {
  SubAgentSpec,
  SubagentPresetLocation,
  SubagentToolOption
} from '../../../shared/settings/types'
import { SettingsField, SettingsPage, SettingsRow, SettingsSection } from './settingsKit'

export interface SubagentPresetDraft {
  preset: SubAgentSpec
  location: SubagentPresetLocation
}

export type SubagentFieldErrors = Partial<Record<
  'name' | 'id' | 'description' | 'allowedTools' | 'prompt' | 'maxToolRounds' | 'contextWindow' | 'model',
  string
>>

interface SubagentPresetFormProps {
  draft: SubagentPresetDraft
  tools: readonly SubagentToolOption[]
  registry: LlmRegistry | null
  disabled?: boolean
  idEditable?: boolean
  showLocation?: boolean
  canUseProject?: boolean
  fieldErrors?: SubagentFieldErrors
  onChange: (draft: SubagentPresetDraft) => void
}

const EFFECT_LABELS: Record<string, string> = {
  'filesystem.read': '读取文件',
  'filesystem.write': '修改文件',
  'shell.execute': '执行命令',
  'process.control': '控制进程',
  'network.read': '访问网络',
  'network.write': '写入网络',
  'session.write': '修改会话',
  orchestration: '派遣代理',
  'mode.transition': '切换模式'
}

function fieldError(message: string | undefined): React.ReactNode {
  return message ? <span className="subagent-form__error" role="alert">{message}</span> : null
}

function modelValue(spec: SubAgentSpec): string {
  if (!spec.model || !('modelEntryId' in spec.model)) return 'default'
  return `${spec.model.providerId}::${spec.model.modelEntryId}`
}

export const SubagentPresetForm: React.FC<SubagentPresetFormProps> = ({
  draft,
  tools,
  registry,
  disabled = false,
  idEditable = false,
  showLocation = true,
  canUseProject = true,
  fieldErrors = {},
  onChange
}) => {
  const selectableModels = useMemo(
    () => registry ? listSelectableModels(registry) : [],
    [registry]
  )
  const modelBinding = draft.preset.model && 'modelEntryId' in draft.preset.model
    ? draft.preset.model
    : undefined
  const selectedModel = modelBinding
    ? selectableModels.find(model =>
        model.providerId === modelBinding.providerId &&
        model.modelEntryId === modelBinding.modelEntryId
      )
    : undefined
  const selectedEntry = selectedModel && registry
    ? registry.providers
        .find(provider => provider.id === selectedModel.providerId)
        ?.models.find(entry => entry.id === selectedModel.modelEntryId)
    : undefined
  const knownEfforts: ReasoningEffort[] = ['auto']
  if (selectedEntry?.reasoningEffort && selectedEntry.reasoningEffort !== 'auto') {
    knownEfforts.push(selectedEntry.reasoningEffort)
  }
  const updatePreset = (patch: Partial<SubAgentSpec>) => {
    onChange({ ...draft, preset: { ...draft.preset, ...patch } })
  }
  const currentEffort = draft.preset.model && 'modelEntryId' in draft.preset.model
    ? draft.preset.model.reasoningEffort ?? 'auto'
    : 'auto'

  return (
    <SettingsPage className="subagent-form">
      <SettingsSection title="基础信息">
        <SettingsField>
          <TextInput
            label="显示名称"
            value={draft.preset.name}
            onChange={name => updatePreset({ name })}
            placeholder="例如：安全审查助手"
            isDisabled={disabled}
            width="100%"
          />
          {fieldError(fieldErrors.name)}
        </SettingsField>
        <SettingsField>
          <TextInput
            label="稳定 ID"
            description={idEditable ? '创建前可以调整；创建后不可修改。' : '创建后不可修改，用于覆盖、恢复和显式派遣。'}
            value={draft.preset.id}
            onChange={id => updatePreset({ id })}
            isDisabled={disabled || !idEditable}
            width="100%"
          />
          {fieldError(fieldErrors.id)}
        </SettingsField>
        <SettingsField>
          <TextArea
            label="适用场景"
            value={draft.preset.description}
            onChange={description => updatePreset({ description })}
            placeholder="说明它适合处理哪些任务，以及不应处理什么。"
            isDisabled={disabled}
            width="100%"
          />
          {fieldError(fieldErrors.description)}
        </SettingsField>
        <SettingsRow
          label="启用"
          description="禁用只影响新的派遣，已有子会话仍可恢复。"
          end={
            <Switch
              label="启用子代理"
              isLabelHidden
              value={draft.preset.enabled}
              onChange={enabled => updatePreset({ enabled })}
              isDisabled={disabled}
            />
          }
        />
        {showLocation && (
          <SettingsRow
            label="保存范围"
            description={draft.location === 'project' ? '仅对当前工作区生效；同 ID 会覆盖全局配置。' : '所有工作区均可使用。'}
            end={
              <Selector
                label="保存范围"
                isLabelHidden
                value={draft.location}
                options={canUseProject
                  ? [
                      { value: 'global', label: '全局' },
                      { value: 'project', label: '当前项目' }
                    ]
                  : [{ value: 'global', label: '全局' }]}
                onChange={value => onChange({ ...draft, location: value as SubagentPresetLocation })}
                isDisabled={disabled}
                width={160}
              />
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title="模型" description="固定模型只保存稳定引用，不保存凭据。">
        <SettingsRow
          label="使用模型"
          description={modelValue(draft.preset) === 'default'
            ? `派遣时采用默认模型${registry ? `（当前：${getActiveModelDisplayName(registry) ?? '不可用'}）` : ''}`
            : '该配置始终使用选中的模型。'}
          end={
            <Selector
              label="使用模型"
              isLabelHidden
              value={modelValue(draft.preset)}
              options={[
                { value: 'default', label: '跟随默认模型（派遣时确定）' },
                ...selectableModels.map(model => ({
                  value: `${model.providerId}::${model.modelEntryId}`,
                  label: `${model.providerName} · ${model.displayName}`
                }))
              ]}
              onChange={value => {
                if (value === 'default') {
                  updatePreset({ model: undefined })
                  return
                }
                const [providerId, modelEntryId] = value.split('::')
                updatePreset({ model: { providerId, modelEntryId } })
              }}
              isDisabled={disabled}
              width={280}
            />
          }
        />
        <SettingsRow
          label="思考强度"
          description={modelValue(draft.preset) === 'default'
            ? '跟随默认模型的配置。'
            : knownEfforts.length === 1
              ? '该模型尚未声明可选强度，只能使用自动。'
              : '仅展示模型注册表明确声明的选项。'}
          end={
            <Selector
              label="思考强度"
              isLabelHidden
              value={knownEfforts.includes(currentEffort) ? currentEffort : 'auto'}
              options={knownEfforts.map(value => ({
                value,
                label: value === 'auto' ? '自动' : value
              }))}
              onChange={value => {
                if (!draft.preset.model || !('modelEntryId' in draft.preset.model)) return
                updatePreset({
                  model: {
                    providerId: draft.preset.model.providerId,
                    modelEntryId: draft.preset.model.modelEntryId,
                    ...(value !== 'auto' ? { reasoningEffort: value as ReasoningEffort } : {})
                  }
                })
              }}
              isDisabled={disabled || modelValue(draft.preset) === 'default'}
              width={160}
            />
          }
        />
        {selectableModels.length === 0 && (
          <SettingsField>
            <span className="settings-status settings-status--warning">没有可用的固定模型。仍可保存为跟随默认模型，并在模型设置中完成配置。</span>
          </SettingsField>
        )}
        {fieldError(fieldErrors.model)}
      </SettingsSection>

      <SettingsSection title="高级配置" variant="bare">
        <details className="subagent-advanced">
          <summary>提示词、工具与运行限制</summary>
          <div className="subagent-advanced__content">
            <SettingsField>
              <TextArea
                label="System prompt"
                value={draft.preset.prompt}
                onChange={prompt => updatePreset({ prompt })}
                isDisabled={disabled}
                hasSpellCheck={false}
                width="100%"
              />
              {fieldError(fieldErrors.prompt)}
            </SettingsField>
            <SettingsField>
              <fieldset className="subagent-tool-fieldset" disabled={disabled}>
                <legend>工具白名单</legend>
                <p>工具来自当前 Tool Catalog；副作用决定子代理的最高权限。</p>
                <div className="subagent-tool-grid">
                  {tools.filter(tool => tool.selectable).map(tool => {
                    const selected = draft.preset.allowedTools.includes(tool.name)
                    const effects = tool.effects.map(effect => EFFECT_LABELS[effect] ?? effect).join('、') || '无外部副作用'
                    return (
                      <label key={tool.name} className="subagent-tool-option">
                        <CheckboxInput
                          label={tool.name}
                          value={selected}
                          onChange={checked => updatePreset({
                            allowedTools: checked
                              ? [...draft.preset.allowedTools, tool.name]
                              : draft.preset.allowedTools.filter(name => name !== tool.name)
                          })}
                          isDisabled={disabled}
                        />
                        <span>{effects}</span>
                      </label>
                    )
                  })}
                </div>
              </fieldset>
              {fieldError(fieldErrors.allowedTools)}
            </SettingsField>
            <SettingsField>
              <div className="subagent-limit-grid">
                <NumberInput
                  label="最大工具轮数"
                  value={draft.preset.maxToolRounds ?? 20}
                  onChange={maxToolRounds => updatePreset({ maxToolRounds: maxToolRounds ?? undefined })}
                  min={1}
                  max={1000}
                  isDisabled={disabled}
                  width="100%"
                />
                <NumberInput
                  label="上下文窗口（tokens）"
                  value={draft.preset.contextWindow ?? null}
                  onChange={contextWindow => updatePreset({ contextWindow: contextWindow ?? undefined })}
                  placeholder="使用模型默认值"
                  min={1}
                  hasClear
                  isDisabled={disabled}
                  width="100%"
                />
              </div>
              {fieldError(fieldErrors.maxToolRounds ?? fieldErrors.contextWindow)}
            </SettingsField>
          </div>
        </details>
      </SettingsSection>
    </SettingsPage>
  )
}
