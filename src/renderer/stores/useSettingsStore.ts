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
import { resolveContextWindow } from '../../shared/config/types'
import type { ChatRequestPurpose } from '../../shared/model/types'
import { projectSessionUsage, type SessionUsageSnapshot } from '../../shared/session/usage'
import type { NovaSettingsDto } from '../../shared/settings/types'
import type { SessionUsageStats } from './types'

export type SettingsTheme = NovaSettingsDto['theme']
export type StreamSmoothness = NovaSettingsDto['streamSmoothness']

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
  /** 持久化 settings.theme 的 renderer 投影，作为 Astryx Theme mode 的唯一 Owner */
  theme: SettingsTheme
  /** 流式输出节奏（smooth=打字机平滑 / instant=即时显示），持久化设置的 renderer 投影 */
  streamSmoothness: StreamSmoothness
  /** 普通模式领航推荐的持久化投影；null 表示尚未读取。 */
  pilotEntryGuideDismissed: boolean | null
  /** 当前会话的只读用量投影；切换后由持久化快照恢复。 */
  sessionUsage: SessionUsageStats | null
  sessionUsageSessionId: string | null
  sessionUsageRevision: number
  /** 按 cacheProfileId 分桶的会话用量；fallback 后进新桶 */
  sessionUsageByProfile: Record<string, SessionUsageStats>
  contextBreakdown: ContextBreakdown | null
  /** 最近一次缓存诊断摘要（ContextIndicator hover 展示） */
  lastCacheDiagnostic: CacheDiagnosticUi | null
  composerPrefill: string | null
  /** 请求导航到的设置分区（外部/跨面板唤起用） */
  requestedSettingsSection: string | null

  // ── Actions ──
  loadLlmRegistry: () => Promise<void>
  /** 从持久化 settings 加载主题模式 */
  loadTheme: () => Promise<void>
  /** 从持久化 settings 加载流式输出节奏 */
  loadStreamSmoothness: () => Promise<void>
  /** 持久化并更新流式输出节奏 */
  setStreamSmoothness: (value: StreamSmoothness) => Promise<void>
  loadPilotEntryGuidePreference: () => Promise<void>
  /** 推荐是一次性轻入口；关闭后立即消失，保存失败也不在当前窗口反复出现。 */
  dismissPilotEntryGuide: () => void
  /** 持久化并更新主题模式；调用方不得维护第二份主题状态 */
  setTheme: (theme: SettingsTheme) => Promise<void>
  /** @deprecated 请使用 loadLlmRegistry */
  loadModelConfig: () => Promise<void>
  saveLlmRegistry: (registry: LlmRegistry) => Promise<void>
  /** @deprecated 请使用 saveLlmRegistry */
  saveModelConfig: (config: ModelConfig) => Promise<void>
  setActiveModel: (providerId: string, modelEntryId: string) => Promise<void>
  fetchProviderModels: (baseUrl: string, apiKey: string, providerId?: string) => Promise<
    { ok: true; modelIds: string[] } | { ok: false; message: string }
  >
  setConfigModalOpen: (isOpen: boolean) => void
  /** 打开设置并定位到 LLM 配置 Tab */
  openLlmSettings: () => void
  /** 打开设置并定位到代码索引分区 */
  openCodeIndexSettings: () => void
  openMemorySettings: () => void
  /** 打开设置并定位到技能与规则定制面板 */
  openCustomizeSettings: (initialTab?: 'skills' | 'rules') => void
  /** 打开设置并定位到领航模式面板 */
  openPilotSettings: () => void
  setRequestedSettingsSection: (section: string | null) => void
  selectProject: () => Promise<void>
  setMode: (mode: Mode) => Promise<void>
  applySessionUsage: (snapshot: SessionUsageSnapshot) => void
  resetSessionUsage: (sessionId?: string | null) => void
  setContextBreakdown: (payload: ContextBreakdown) => void
  setCacheDiagnostic: (diagnostic: CacheDiagnosticUi | null) => void
  syncFromWorkspace: (project: string | null, mode: Mode) => void
  requestComposerPrefill: (text: string) => void
  clearComposerPrefill: () => void
}

/** UI 消费的缓存诊断摘要（不含哈希明文） */
export interface CacheDiagnosticUi {
  messageId: string
  cacheBreakDetected: boolean
  reason?: string
  suggestion?: string
  firstDiffIndex?: number | null
  firstDiffPart?: string | null
  estimatedInvalidatedTokens?: number
  expectedReuseTokens?: number
  actualCacheReadTokens?: number
  /** 请求用途标记（压缩摘要等受控内部调用）；主对话为 undefined */
  purpose?: ChatRequestPurpose
}

import type { ContextBreakdown } from '../../shared/agent/contextBreakdown'

export type { ContextBreakdown }

const SETTINGS_NAV_KEY = 'nova-settings-nav'

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
      resolveContextWindow(modelConfig?.modelId ?? '', modelConfig?.contextWindow)
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  llmRegistry: null,
  modelConfig: null,
  contextLimit: 200_000,
  isConfigModalOpen: false,
  currentProject: null,
  currentMode: 'default',
  theme: (typeof localStorage !== 'undefined' && (localStorage.getItem('nova-settings-theme') as SettingsTheme)) || 'system',
  streamSmoothness:
    typeof localStorage !== 'undefined' && localStorage.getItem('nova-settings-stream-smoothness') === 'instant'
      ? 'instant'
      : 'smooth',
  pilotEntryGuideDismissed: null,
  sessionUsage: null,
  sessionUsageSessionId: null,
  sessionUsageRevision: 0,
  sessionUsageByProfile: {},
  contextBreakdown: null,
  lastCacheDiagnostic: null,
  composerPrefill: null,
  requestedSettingsSection: null,

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

  loadTheme: async () => {
    try {
      const settings = await window.api.invoke('settings:get')
      try {
        localStorage.setItem('nova-settings-theme', settings.theme)
      } catch (_) {}
      set({ theme: settings.theme })
    } catch (err) {
      console.error('读取主题设置失败:', err)
    }
  },

  loadStreamSmoothness: async () => {
    try {
      const settings = await window.api.invoke('settings:get')
      try {
        localStorage.setItem('nova-settings-stream-smoothness', settings.streamSmoothness)
      } catch (_) {}
      set({ streamSmoothness: settings.streamSmoothness })
    } catch (err) {
      console.error('读取流式节奏设置失败:', err)
    }
  },

  setStreamSmoothness: async (value: StreamSmoothness) => {
    try {
      const settings = await window.api.invoke('settings:set', { streamSmoothness: value })
      try {
        localStorage.setItem('nova-settings-stream-smoothness', settings.streamSmoothness)
      } catch (_) {}
      set({ streamSmoothness: settings.streamSmoothness })
    } catch (err) {
      console.error('保存流式节奏设置失败:', err)
      throw err
    }
  },

  loadPilotEntryGuidePreference: async () => {
    if (get().pilotEntryGuideDismissed !== null) return
    try {
      const settings = await window.api.invoke('settings:get')
      // 读取期间的关闭操作优先，迟到的旧快照不能重新显示推荐。
      if (get().pilotEntryGuideDismissed === null) {
        set({ pilotEntryGuideDismissed: settings.pilotEntryGuideDismissed })
      }
    } catch (err) {
      console.error('读取领航推荐偏好失败:', err)
    }
  },

  dismissPilotEntryGuide: () => {
    set({ pilotEntryGuideDismissed: true })
    void window.api.invoke('settings:set', { pilotEntryGuideDismissed: true }).catch((error: unknown) => {
      console.error('保存领航推荐偏好失败:', error)
    })
  },

  setTheme: async (theme: SettingsTheme) => {
    try {
      const settings = await window.api.invoke('settings:set', { theme })
      try {
        localStorage.setItem('nova-settings-theme', settings.theme)
      } catch (_) {}
      set({ theme: settings.theme })
    } catch (err) {
      console.error('保存主题设置失败:', err)
      throw err
    }
  },

  saveLlmRegistry: async (registry: LlmRegistry) => {
    try {
      await window.api.invoke('save-llm-registry', registry)
      const derived = deriveModelState(registry)
      set({ llmRegistry: registry, ...derived })
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

  fetchProviderModels: async (baseUrl: string, apiKey: string, providerId?: string) => {
    return window.api.invoke('fetch-provider-models', { baseUrl, apiKey, providerId })
  },

  setConfigModalOpen: (isOpen: boolean) => {
    set({ isConfigModalOpen: isOpen })
  },

  openLlmSettings: () => {
    try {
      sessionStorage.setItem(SETTINGS_NAV_KEY, 'llm')
    } catch {
      // 忽略
    }
    set({ isConfigModalOpen: true })
  },

  openCodeIndexSettings: () => {
    try {
      sessionStorage.setItem(SETTINGS_NAV_KEY, 'codeindex')
    } catch {
      // sessionStorage 不可用时仍可打开设置壳层。
    }
    set({ isConfigModalOpen: true })
  },

  openMemorySettings: () => {
    try { sessionStorage.setItem(SETTINGS_NAV_KEY, 'memory') } catch { /* Opening remains available without browser storage. */ }
    set({ isConfigModalOpen: true })
  },

  openCustomizeSettings: (initialTab = 'rules') => {
    try {
      sessionStorage.setItem(SETTINGS_NAV_KEY, initialTab)
    } catch {
      // 忽略
    }
    set({ isConfigModalOpen: true, requestedSettingsSection: initialTab })
  },

  openPilotSettings: () => {
    try {
      sessionStorage.setItem(SETTINGS_NAV_KEY, 'pilot')
    } catch {
      // 忽略
    }
    set({ isConfigModalOpen: true, requestedSettingsSection: 'pilot' })
  },

  setRequestedSettingsSection: (section: string | null) => {
    set({ requestedSettingsSection: section })
  },

  selectProject: async () => {
    const { useWorkspaceStore } = await import('./useWorkspaceStore')
    await useWorkspaceStore.getState().selectProject()
  },

  setMode: async (mode: Mode) => {
    const { useWorkspaceStore } = await import('./useWorkspaceStore')
    await useWorkspaceStore.getState().setMode(mode)
  },

  applySessionUsage: (snapshot) => {
    set(state => {
      if (snapshot.sessionId !== state.sessionUsageSessionId || snapshot.revision <= state.sessionUsageRevision) return state
      return { ...projectSessionUsage(snapshot), sessionUsageRevision: snapshot.revision }
    })
  },

  resetSessionUsage: (sessionId = null) => {
    set({ sessionUsageSessionId: sessionId, sessionUsageRevision: 0,
      sessionUsage: null, sessionUsageByProfile: {}, lastCacheDiagnostic: null })
  },

  setContextBreakdown: (payload) => {
    set(state => state.contextBreakdown?.sessionId === payload.sessionId && state.contextBreakdown.capturedAt > payload.capturedAt
      ? state : { contextBreakdown: payload })
  },

  setCacheDiagnostic: (diagnostic) => {
    set({ lastCacheDiagnostic: diagnostic })
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
    theme: 'system',
    pilotEntryGuideDismissed: null,
    sessionUsage: null,
    sessionUsageSessionId: null,
    sessionUsageRevision: 0,
    sessionUsageByProfile: {},
    contextBreakdown: null,
    lastCacheDiagnostic: null,
    composerPrefill: null,
    requestedSettingsSection: null
  })
}
