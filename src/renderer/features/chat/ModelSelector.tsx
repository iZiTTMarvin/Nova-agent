/**
 * Composer 模型选择器 — 级联下拉，支持按服务商分组。
 *
 * DropdownMenu 的嵌套 items 保留了原有的“服务商 → 模型”选择语义，
 * 同时把触发器、键盘导航、焦点回收和菜单层交给 Astryx 统一处理。
 */
import React, { useMemo } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu'
import { useSettingsStore } from '../../stores/useSettingsStore'
import {
  groupSelectableModels,
  getActiveModelDisplayName
} from '../../../shared/config/llmRegistry'
import { CheckSmallIcon } from '../../components/Icons'

export const ModelSelector: React.FC = () => {
  const llmRegistry = useSettingsStore(state => state.llmRegistry)
  const setActiveModel = useSettingsStore(state => state.setActiveModel)
  const openLlmSettings = useSettingsStore(state => state.openLlmSettings)

  const groups = llmRegistry ? groupSelectableModels(llmRegistry) : []
  const displayName = llmRegistry ? getActiveModelDisplayName(llmRegistry) : null
  const hasModels = groups.length > 0
  const activeRef = llmRegistry?.activeModel

  const isActiveModel = (providerId: string, modelEntryId: string) =>
    activeRef?.providerId === providerId && activeRef?.modelEntryId === modelEntryId

  const handleSelect = async (providerId: string, modelEntryId: string) => {
    try {
      await setActiveModel(providerId, modelEntryId)
    } catch {
      // store 已打日志
    }
  }

  const menuItems = useMemo<DropdownMenuOption[]>(() => {
    const items: DropdownMenuOption[] = []
    for (const group of groups) {
      const modelItems = group.models.map(model => ({
        label: model.displayName,
        icon: isActiveModel(model.providerId, model.modelEntryId)
          ? <CheckSmallIcon size={14} />
          : undefined,
        onClick: () => void handleSelect(model.providerId, model.modelEntryId)
      }))

      if (group.models.length === 1) {
        items.push(modelItems[0])
      } else {
        items.push({
          label: group.providerName,
          items: modelItems
        })
      }
    }

    items.push({ type: 'divider' })
    items.push({
      label: '管理模型',
      onClick: openLlmSettings
    })
    return items
  }, [groups, activeRef, openLlmSettings, setActiveModel])

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
        label: '切换模型',
        variant: 'ghost',
        size: 'sm',
        tooltip: '切换模型',
        children: (
          <span className="model-selector__label">
            {displayName ?? '选择模型'}
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
