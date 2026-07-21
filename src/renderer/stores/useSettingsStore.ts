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
import type { NormalizedUsage } from '../../shared/model/types'
import { computeCacheHitRate } from '../../shared/model/types'
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
  /**
   * 全部分桶合计（兼容旧 UI / 测试）。
   * 有数据时非 null；reset 后清空。
   */
  sessionUsage: SessionUsageStats | null
  /** 按 cacheProfileId 分桶的会话用量；fallback 后进新桶 */
  sessionUsageByProfile: Record<string, SessionUsageStats>
  contextBreakdown: ContextBreakdown | null
  /** 最近一次缓存诊断摘要（ContextIndicator hover 展示） */
  lastCacheDiagnostic: CacheDiagnosticUi | null
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
  /**
   * 累计本轮 usage。
   * @param cacheProfileId 实际 provider 档案；缺省时归入 'unknown'（兼容旧测试调用）
   */
  handleUsage: (usage: NormalizedUsage, cacheProfileId?: string) => void
  resetSessionUsage: () => void
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
  expectedMiss?: boolean
}

const EMPTY_USAGE: SessionUsageStats = {
  totalUncachedInputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  totalOutputTokens: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalCachedTokens: 0,
  hitRate: 0,
  lastRoundHitRate: 0,
  estimatedSavedInputTokens: 0
}

/** 无 profileId 时的兜底桶名（旧测试 / 未接线路径） */
const UNKNOWN_PROFILE_BUCKET = 'unknown'

/** 把单轮 usage 累加进已有 SessionUsageStats（单一命中率公式） */
function accumulateUsage(prev: SessionUsageStats, usage: NormalizedUsage): SessionUsageStats {
  const cacheRead = usage.cacheReadTokens ?? usage.cachedTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const output = usage.outputTokens ?? usage.completionTokens ?? 0
  const uncached =
    usage.uncachedInputTokens ??
    (usage.cacheMissTokens !== undefined
      ? usage.cacheMissTokens
      : Math.max(0, (usage.promptTokens ?? 0) - cacheRead))

  const totalUncached = prev.totalUncachedInputTokens + uncached
  const totalCacheRead = prev.totalCacheReadTokens + cacheRead
  const totalCacheWrite = prev.totalCacheWriteTokens + cacheWrite
  const totalOutput = prev.totalOutputTokens + output

  const lastRoundHitRate = computeCacheHitRate({
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite
  })
  const hitRate = computeCacheHitRate({
    uncachedInputTokens: totalUncached,
    cacheReadTokens: totalCacheRead,
    cacheWriteTokens: totalCacheWrite
  })

  const hasMissThisRound = usage.cacheMissTokens !== undefined
  const totalMiss = hasMissThisRound
    ? (prev.totalCacheMissTokens ?? 0) + usage.cacheMissTokens!
    : prev.totalCacheMissTokens

  const next: SessionUsageStats = {
    totalUncachedInputTokens: totalUncached,
    totalCacheReadTokens: totalCacheRead,
    totalCacheWriteTokens: totalCacheWrite,
    totalOutputTokens: totalOutput,
    totalPromptTokens: totalUncached + totalCacheRead,
    totalCompletionTokens: totalOutput,
    totalCachedTokens: totalCacheRead,
    hitRate,
    lastRoundHitRate,
    estimatedSavedInputTokens: totalCacheRead
  }
  if (totalMiss !== undefined) {
    next.totalCacheMissTokens = totalMiss
  }
  return next
}

/** 多分桶合计，供兼容 sessionUsage 与 compact 摘要 */
function aggregateUsageBuckets(buckets: Record<string, SessionUsageStats>): SessionUsageStats | null {
  const values = Object.values(buckets)
  if (values.length === 0) return null

  let totalUncached = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let totalOutput = 0
  let totalMiss: number | undefined
  let lastRoundHitRate = 0

  for (const b of values) {
    totalUncached += b.totalUncachedInputTokens
    totalCacheRead += b.totalCacheReadTokens
    totalCacheWrite += b.totalCacheWriteTokens
    totalOutput += b.totalOutputTokens
    lastRoundHitRate = b.lastRoundHitRate
    if (b.totalCacheMissTokens !== undefined) {
      totalMiss = (totalMiss ?? 0) + b.totalCacheMissTokens
    }
  }

  const next: SessionUsageStats = {
    totalUncachedInputTokens: totalUncached,
    totalCacheReadTokens: totalCacheRead,
    totalCacheWriteTokens: totalCacheWrite,
    totalOutputTokens: totalOutput,
    totalPromptTokens: totalUncached + totalCacheRead,
    totalCompletionTokens: totalOutput,
    totalCachedTokens: totalCacheRead,
    hitRate: computeCacheHitRate({
      uncachedInputTokens: totalUncached,
      cacheReadTokens: totalCacheRead,
      cacheWriteTokens: totalCacheWrite
    }),
    lastRoundHitRate,
    estimatedSavedInputTokens: totalCacheRead
  }
  if (totalMiss !== undefined) {
    next.totalCacheMissTokens = totalMiss
  }
  return next
}

import type { ContextBreakdown } from '../../shared/agent/contextBreakdown'

export type { ContextBreakdown }

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
  sessionUsage: null,
  sessionUsageByProfile: {},
  contextBreakdown: null,
  lastCacheDiagnostic: null,
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

  handleUsage: (usage: NormalizedUsage, cacheProfileId?: string) => {
    const bucketId = cacheProfileId && cacheProfileId.length > 0
      ? cacheProfileId
      : UNKNOWN_PROFILE_BUCKET
    set(state => {
      const prevBucket = state.sessionUsageByProfile[bucketId] ?? EMPTY_USAGE
      const nextBucket = accumulateUsage(prevBucket, usage)
      const sessionUsageByProfile = {
        ...state.sessionUsageByProfile,
        [bucketId]: nextBucket
      }
      return {
        sessionUsageByProfile,
        sessionUsage: aggregateUsageBuckets(sessionUsageByProfile)
      }
    })
  },

  resetSessionUsage: () => {
    set({ sessionUsage: null, sessionUsageByProfile: {}, lastCacheDiagnostic: null })
  },

  setContextBreakdown: (payload) => {
    set({ contextBreakdown: payload })
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
    sessionUsage: null,
    sessionUsageByProfile: {},
    contextBreakdown: null,
    lastCacheDiagnostic: null,
    composerPrefill: null
  })
}
