/**
 * Composer 模型选择器 — 只负责切换当前会话的模型。
 *
 * 模型是会话级覆盖（无会话时写全局最近选择）；思考强度由
 * ReasoningEffortControl 独立承担，两者互不耦合。
 */
import React, { useCallback, useMemo } from 'react'
import { Button } from '@astryxdesign/core/Button'
import {
  DropdownMenu,
  type DropdownMenuItemData,
  type DropdownMenuOption
} from '@astryxdesign/core/DropdownMenu'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import {
  groupSelectableModels,
  getModelDisplayName,
  type ActiveModelRef
} from '../../../shared/config/llmRegistry'
import { CheckSmallIcon } from '../../components/Icons'

export const ModelSelector: React.FC = () => {
  const llmRegistry = useSettingsStore(state => state.llmRegistry)
  const setActiveModel = useSettingsStore(state => state.setActiveModel)
  const openLlmSettings = useSettingsStore(state => state.openLlmSettings)
  const activeModelRef = useWorkspaceStore(state => state.activeModelRef)
  const currentSessionId = useWorkspaceStore(state => state.currentSessionId)
  const setSessionModel = useWorkspaceStore(state => state.setSessionModel)

  const groups = llmRegistry ? groupSelectableModels(llmRegistry) : []
  const hasModels = groups.length > 0
  // 会话有效引用优先；广播未到达（或未配置）时回退注册表活跃模型
  const currentRef: ActiveModelRef | null = activeModelRef ?? llmRegistry?.activeModel ?? null
  const displayName = llmRegistry ? getModelDisplayName(llmRegistry, activeModelRef ?? undefined) : null

  const isCurrentModel = useCallback(
    (providerId: string, modelEntryId: string) =>
      currentRef?.providerId === providerId && currentRef?.modelEntryId === modelEntryId,
    [currentRef?.modelEntryId, currentRef?.providerId]
  )

  const handleSelectModel = useCallback(async (ref: ActiveModelRef) => {
    try {
      if (currentSessionId) {
        await setSessionModel(ref)
      } else {
        // 无会话：写全局最近选择，供首个会话与后续新会话继承
        await setActiveModel(ref.providerId, ref.modelEntryId)
      }
    } catch (err) {
      console.error('[ModelSelector] 切换模型失败:', err)
    }
  }, [currentSessionId, setActiveModel, setSessionModel])

  const menuItems = useMemo<DropdownMenuOption[]>(() => {
    const checked = <CheckSmallIcon size={14} />
    const items: DropdownMenuItemData[] = []

    for (const group of groups) {
      const models = group.models.map(model => ({
        label: model.displayName,
        icon: isCurrentModel(model.providerId, model.modelEntryId) ? checked : undefined,
        onClick: () => void handleSelectModel({
          providerId: model.providerId,
          modelEntryId: model.modelEntryId
        })
      }))
      items.push(models.length === 1 ? models[0]! : { label: group.providerName, items: models })
    }

    return [
      { type: 'section', title: '模型', items },
      { type: 'divider' },
      { label: '管理模型…', onClick: openLlmSettings }
    ]
  }, [groups, handleSelectModel, isCurrentModel, openLlmSettings])

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
          <span className="model-selector__label">{displayName ?? '选择模型'}</span>
        )
      }}
      items={menuItems}
      placement="above"
      menuWidth={240}
      className="model-selector"
    />
  )
}
