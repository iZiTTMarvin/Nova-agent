/**
 * Composer 复合选择器 — 触发器显示「模型名 · 生效思考强度」。
 *
 * 主菜单为思考强度单选区（会话级覆盖，见 CONTEXT.md）+ 级联模型子菜单；
 * 子菜单复用「服务商 → 模型」结构，尾部固定「管理模型」。
 * 触发器、键盘导航、焦点回收和菜单层交给 Astryx 统一处理。
 */
import React, { useMemo } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import {
  groupSelectableModels,
  getActiveModelDisplayName,
  getActiveModelReasoningEffort,
  type ReasoningEffort
} from '../../../shared/config/llmRegistry'
import { CheckSmallIcon } from '../../components/Icons'

const EFFORT_VALUES: ReasoningEffort[] = ['auto', 'low', 'medium', 'high', 'max']

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  auto: 'auto（不发送参数）',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max'
}

export const ModelSelector: React.FC = () => {
  const llmRegistry = useSettingsStore(state => state.llmRegistry)
  const setActiveModel = useSettingsStore(state => state.setActiveModel)
  const openLlmSettings = useSettingsStore(state => state.openLlmSettings)
  const override = useWorkspaceStore(state => state.reasoningEffortOverride)
  const setReasoningEffortOverride = useWorkspaceStore(
    state => state.setReasoningEffortOverride
  )

  const groups = llmRegistry ? groupSelectableModels(llmRegistry) : []
  const displayName = llmRegistry ? getActiveModelDisplayName(llmRegistry) : null
  const defaultEffort = llmRegistry ? getActiveModelReasoningEffort(llmRegistry) : 'auto'
  const effectiveEffort = override ?? defaultEffort
  const hasModels = groups.length > 0
  const activeRef = llmRegistry?.activeModel

  const isActiveModel = (providerId: string, modelEntryId: string) =>
    activeRef?.providerId === providerId && activeRef?.modelEntryId === modelEntryId

  const handleSelectModel = async (providerId: string, modelEntryId: string) => {
    try {
      await setActiveModel(providerId, modelEntryId)
    } catch {
      // store 已打日志
    }
  }

  const handleSelectEffort = async (effort: ReasoningEffort | null) => {
    await setReasoningEffortOverride(effort)
  }

  const menuItems = useMemo<DropdownMenuOption[]>(() => {
    const checked = <CheckSmallIcon size={14} />

    const effortItems = [
      {
        label:
          defaultEffort === 'auto'
            ? '跟随模型默认'
            : `跟随模型默认（当前 ${defaultEffort}）`,
        icon: override === null ? checked : undefined,
        onClick: () => void handleSelectEffort(null)
      },
      ...EFFORT_VALUES.map(value => ({
        label: EFFORT_LABELS[value],
        icon: override === value ? checked : undefined,
        onClick: () => void handleSelectEffort(value)
      }))
    ]

    const modelItems: DropdownMenuOption[] = []
    for (const group of groups) {
      const items = group.models.map(model => ({
        label: model.displayName,
        icon: isActiveModel(model.providerId, model.modelEntryId) ? checked : undefined,
        onClick: () => void handleSelectModel(model.providerId, model.modelEntryId)
      }))

      if (items.length === 1) {
        modelItems.push(items[0])
      } else {
        modelItems.push({ label: group.providerName, items })
      }
    }
    modelItems.push({ type: 'divider' })
    modelItems.push({ label: '管理模型', onClick: openLlmSettings })

    return [
      { type: 'section', title: '思考强度', items: effortItems },
      { type: 'divider' },
      { label: displayName ?? '选择模型', items: modelItems }
    ]
  }, [groups, activeRef, override, defaultEffort, displayName, openLlmSettings, setActiveModel, setReasoningEffortOverride])

  if (!hasModels) {
    return (
      <Button
        label="未配置"
        variant="ghost"
        size="sm"
        tooltip="配置模型"
        onClick={openLlmSettings}
        className="model-selector__trigger"
      />
    )
  }

  return (
    <DropdownMenu
      button={{
        label: '切换模型与思考强度',
        variant: 'ghost',
        size: 'sm',
        tooltip: '切换模型与思考强度',
        children: (
          <span className="model-selector__label">
            {displayName ?? '选择模型'} · {effectiveEffort}
          </span>
        )
      }}
      items={menuItems}
      placement="above"
      menuWidth={240}
      className="model-selector"
    />
  )
}
