/**
 * useSettingsStore — 模型配置、UI 开关、用量统计
 */
import { create } from 'zustand'
import type { Mode } from '../../shared/session/types'
import type { ModelConfig } from '../../shared/config'
import type { LlmRegistry } from '../../shared/config/llmRegistry'
import {
  resolveActiveModelConfig,
  createEmptyRegistry
} from '../../shared/config/llmRegistry'
import { inferContextWindow } from '../../shared/config/types'
import type { NormalizedUsage } from '../../runtime/model/types'
import type { SessionUsageStats } from './types'

export interface SettingsState {
  // ── 状态 ──
  /** LLM 多服务商注册表 */
  llmRegistry: LlmRegistry | null
  /** 当前活跃模型配置（由 llmRegistry 派生，供 Agent 与 vision 判断） */
  modelConfig: ModelConfig | null
  contextLimit: number
  isConfigModalOpen: boolean
  currentProject: string | null
  currentMode: Mode
  sessionUsage: SessionUsageStats | null
  contextBreakdown: ContextBreakdown | null
  composerPrefill: string | null

  // ── Actions ──
  loadLlmRegistry: () => Promise<void>
  /** @deprecated 请使用 loadLlmRegistry */
  loadModelConfig: () => Promise<void>
  saveLlmRegistry: (registry: LlmRegistry) => Promise<void>
  /** @deprecated 请使用 saveLlmRegistry */
  saveModelConfig: (config: ModelConfig) => Promise<void>
  setActiveModel: (providerId: string, modelEntryId: string) => Promise<void>
  fetchProviderModels: (baseUrl: string, apiKey: string) => Promise<
    { ok: true; modelIds: string[] } | { ok: false; message: string }
  >
  setConfigModalOpen: (isOpen: boolean) => void
  /** 打开设置并定位到 LLM 配置 Tab */
  openLlmSettings: () => void
  selectProject: () => Promise<void>
  setMode: (mode: Mode) => Promise<void>
  handleUsage: (usage: NormalizedUsage) => void
  resetSessionUsage: () => void
  setContextBreakdown: (payload: ContextBreakdown) => void
  syncFromWorkspace: (project: string | null, mode: Mode) => void
  requestComposerPrefill: (text: string) => void
  clearComposerPrefill: () => void
}

const EMPTY_USAGE: SessionUsageStats = {
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalCachedTokens: 0,
  totalCacheWriteTokens: 0,
  hitRate: 0
}

export interface ContextBreakdown {
  sessionId: string
  messageId: string
  breakdown: {
    systemPrompt: number
    skills: number
    tools: number
    messages: number
    other: number
  }
  totalEstimated: number
  promptTokensActual: number
  capturedAt: number
  contextLimit?: number
}

const LLM_SETTINGS_NAV_KEY = 'nova-settings-nav'

function deriveModelState(registry: LlmRegistry | null): {
  modelConfig: ModelConfig | null
  contextLimit: number
} {
  if (!registry) {
    return { modelConfig: null, contextLimit: 200_000 }
  }
  const modelConfig = resolveActiveModelConfig(registry)
  return {
    modelConfig,
    contextLimit:
      modelConfig?.contextWindow ?? inferContextWindow(modelConfig?.modelId ?? '')
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  llmRegistry: null,
  modelConfig: null,
  contextLimit: 200_000,
  isConfigModalOpen: false,
  currentProject: null,
  currentMode: 'default',
  sessionUsage: null,
  contextBreakdown: null,
  composerPrefill: null,

  loadLlmRegistry: async () => {
    try {
      const registry = await window.api.invoke('load-llm-registry')
      const derived = deriveModelState(registry)
      set({ llmRegistry: registry, ...derived })
    } catch (err) {
      console.error('读取 LLM 注册表失败:', err)
    }
  },

  loadModelConfig: async () => {
    await get().loadLlmRegistry()
  },

  saveLlmRegistry: async (registry: LlmRegistry) => {
    try {
      await window.api.invoke('save-llm-registry', registry)
      const derived = deriveModelState(registry)
      set({
        llmRegistry: registry,
        ...derived,
        isConfigModalOpen: false
      })
    } catch (err) {
      console.error('保存 LLM 注册表失败:', err)
      throw err
    }
  },

  saveModelConfig: async (config: ModelConfig) => {
    try {
      await window.api.invoke('save-model-config', config)
      await get().loadLlmRegistry()
      set({ isConfigModalOpen: false })
    } catch (err) {
      console.error('保存模型配置失败:', err)
      throw err
    }
  },

  setActiveModel: async (providerId: string, modelEntryId: string) => {
    try {
      await window.api.invoke('set-active-model', { providerId, modelEntryId })
      const registry = get().llmRegistry
      if (registry) {
        const next: LlmRegistry = {
          ...registry,
          activeModel: { providerId, modelEntryId }
        }
        const derived = deriveModelState(next)
        set({ llmRegistry: next, ...derived })
      } else {
        await get().loadLlmRegistry()
      }
    } catch (err) {
      console.error('切换模型失败:', err)
      throw err
    }
  },

  fetchProviderModels: async (baseUrl: string, apiKey: string) => {
    return window.api.invoke('fetch-provider-models', { baseUrl, apiKey })
  },

  setConfigModalOpen: (isOpen: boolean) => {
    set({ isConfigModalOpen: isOpen })
  },

  openLlmSettings: () => {
    try {
      sessionStorage.setItem(LLM_SETTINGS_NAV_KEY, 'llm')
    } catch {
      // 忽略
    }
    set({ isConfigModalOpen: true })
  },

  selectProject: async () => {
    const { useWorkspaceStore } = await import('./useWorkspaceStore')
    await useWorkspaceStore.getState().selectProject()
  },

  setMode: async (mode: Mode) => {
    const { useWorkspaceStore } = await import('./useWorkspaceStore')
    await useWorkspaceStore.getState().setMode(mode)
  },

  handleUsage: (usage: NormalizedUsage) => {
    set(state => {
      const prev = state.sessionUsage ?? EMPTY_USAGE
      const totalPrompt = prev.totalPromptTokens + usage.promptTokens
      const totalCached = prev.totalCachedTokens + usage.cachedTokens
      const totalCacheWrite = prev.totalCacheWriteTokens + (usage.cacheWriteTokens ?? 0)
      const totalInput = totalPrompt + totalCacheWrite
      return {
        sessionUsage: {
          totalPromptTokens: totalPrompt,
          totalCompletionTokens: prev.totalCompletionTokens + usage.completionTokens,
          totalCachedTokens: totalCached,
          totalCacheWriteTokens: totalCacheWrite,
          hitRate: totalInput > 0 ? totalCached / totalInput : 0
        }
      }
    })
  },

  resetSessionUsage: () => {
    set({ sessionUsage: null })
  },

  setContextBreakdown: (payload) => {
    set({ contextBreakdown: payload })
  },

  syncFromWorkspace: (project: string | null, mode: Mode) => {
    if (get().currentProject !== project || get().currentMode !== mode) {
      set({ currentProject: project, currentMode: mode })
    }
  },

  requestComposerPrefill: (text: string) => {
    set({ composerPrefill: text, isConfigModalOpen: false })
  },

  clearComposerPrefill: () => {
    set({ composerPrefill: null })
  }
}))

/** 获取默认空注册表（首次配置用） */
export function getDefaultLlmRegistry(): LlmRegistry {
  return createEmptyRegistry()
}

export function resetSettingsStoreForTests(): void {
  useSettingsStore.setState({
    llmRegistry: null,
    modelConfig: null,
    contextLimit: 200_000,
    isConfigModalOpen: false,
    currentProject: null,
    currentMode: 'default',
    sessionUsage: null,
    contextBreakdown: null,
    composerPrefill: null
  })
}
