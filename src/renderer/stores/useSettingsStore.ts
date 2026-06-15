/**
 * useSettingsStore — 模型配置、UI 开关、用量统计
 *
 * 负责：
 * - ModelConfig 加载与保存
 * - isConfigModalOpen（设置弹窗显隐）
 * - sessionUsage（会话级 token 用量聚合）
 * - composerPrefill（设置页「使用技能」后预填 composer）
 *
 * 架构变更（PRD §5.1 工作区单一事实源）：
 * - currentProject / currentMode 不再由本 store 维护，改由 useWorkspaceStore 作为唯一事实源。
 * - 本 store 通过订阅 useWorkspaceStore 把 currentProject/currentMode 作为派生镜像保留，
 *   仅为 useAppStore 兼容层和既有组件零改动工作。
 * - selectProject / setMode 改为转发到 useWorkspaceStore，不再直接 IPC + 反向写 chat store。
 *
 * 依赖方向：
 * - 订阅 useWorkspaceStore（单向，只读派生）
 * - 被 useChatStore（sendMessage 读取 currentProject）和 useAppStore 读取
 */
import { create } from 'zustand'
import type { Mode } from '../../shared/session/types'
import type { ModelConfig } from '../../shared/config'
import { inferContextWindow } from '../../shared/config/types'
import type { NormalizedUsage } from '../../runtime/model/types'
import type { SessionUsageStats } from './types'

export interface SettingsState {
  // ── 状态 ──
  modelConfig: ModelConfig | null
  /** 模型上下文窗口上限（tokens），用于前端显示上下文占用指示器 */
  contextLimit: number
  isConfigModalOpen: boolean
  /**
   * 当前工作区路径（派生镜像，源自 useWorkspaceStore）。
   * 仅供 useAppStore 兼容层与既有组件零改动；不再由本 store 主动写入。
   */
  currentProject: string | null
  /** 当前运行模式（派生镜像，源自 useWorkspaceStore） */
  currentMode: Mode
  /** 当前会话的 token 用量聚合统计 */
  sessionUsage: SessionUsageStats | null
  /**
   * 上下文容量分项 token 估算(来自 agent:context-breakdown 推送)。
   * null 表示本会话还没收到过推送(无 LLM 调用)。
   */
  contextBreakdown: ContextBreakdown | null
  /** 设置页「使用技能」后预填到 composer 的文本 */
  composerPrefill: string | null

  // ── Actions ──
  /** 加载持久化的模型配置 */
  loadModelConfig: () => Promise<void>
  /** 保存新模型配置 */
  saveModelConfig: (config: ModelConfig) => Promise<void>
  /** 打开或关闭配置弹窗 */
  setConfigModalOpen: (isOpen: boolean) => void
  /** 选择项目（转发到 useWorkspaceStore） */
  selectProject: () => Promise<void>
  /** 更换当前运行模式（转发到 useWorkspaceStore） */
  setMode: (mode: Mode) => Promise<void>
  /** 累计一次 token 用量 */
  handleUsage: (usage: NormalizedUsage) => void
  /** 切换会话时清空用量统计 */
  resetSessionUsage: () => void
  /** 写入/覆盖本轮分项 token 估算(来自 agent:context-breakdown) */
  setContextBreakdown: (payload: ContextBreakdown) => void
  /**
   * 由 useWorkspaceStore 同步调用：把工作区最新状态镜像到本 store。
   * 这是单向数据流：workspace store → settings store（派生镜像），
   * 不允许其他模块直接调用此方法写 currentProject/currentMode。
   * @internal
   */
  syncFromWorkspace: (project: string | null, mode: Mode) => void
  /** 关闭设置并预填 composer（如 `/onboard `） */
  requestComposerPrefill: (text: string) => void
  /** ChatPanel 消费后清空 */
  clearComposerPrefill: () => void
}

const EMPTY_USAGE: SessionUsageStats = {
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalCachedTokens: 0,
  totalCacheWriteTokens: 0,
  hitRate: 0
}

/** 上下文容量分项 token 估算(本轮 LLM 调用实际发给模型的拆分) */
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
  /** 计算时使用的上下文窗口上限(部分场景需要覆盖 store 里的默认值) */
  contextLimit?: number
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  modelConfig: null,
  contextLimit: 200_000,
  isConfigModalOpen: false,
  currentProject: null,
  currentMode: 'default',
  sessionUsage: null,
  contextBreakdown: null,
  composerPrefill: null,

  loadModelConfig: async () => {
    try {
      const config = await window.api.invoke('load-model-config')
      set({
        modelConfig: config,
        contextLimit: config?.contextWindow ?? inferContextWindow(config?.modelId ?? '')
      })
    } catch (err) {
      console.error('读取模型配置失败:', err)
    }
  },

  saveModelConfig: async (config: ModelConfig) => {
    try {
      await window.api.invoke('save-model-config', config)
      set({
        modelConfig: config,
        isConfigModalOpen: false,
        contextLimit: config.contextWindow ?? inferContextWindow(config.modelId)
      })
    } catch (err) {
      console.error('保存模型配置失败:', err)
      throw err
    }
  },

  setConfigModalOpen: (isOpen: boolean) => {
    set({ isConfigModalOpen: isOpen })
  },

  selectProject: async () => {
    // 转发到 workspace store（单一事实源），不再自己 IPC + 反向写 chat store
    const { useWorkspaceStore } = await import('./useWorkspaceStore')
    await useWorkspaceStore.getState().selectProject()
  },

  setMode: async (mode: Mode) => {
    // 转发到 workspace store
    const { useWorkspaceStore } = await import('./useWorkspaceStore')
    await useWorkspaceStore.getState().setMode(mode)
  },

  handleUsage: (usage: NormalizedUsage) => {
    set(state => {
      const prev = state.sessionUsage ?? EMPTY_USAGE
      const totalPrompt = prev.totalPromptTokens + usage.promptTokens
      const totalCached = prev.totalCachedTokens + usage.cachedTokens
      const totalCacheWrite = prev.totalCacheWriteTokens + (usage.cacheWriteTokens ?? 0)
      return {
        sessionUsage: {
          totalPromptTokens: totalPrompt,
          totalCompletionTokens: prev.totalCompletionTokens + usage.completionTokens,
          totalCachedTokens: totalCached,
          totalCacheWriteTokens: totalCacheWrite,
          hitRate: totalPrompt > 0 ? totalCached / totalPrompt : 0
        }
      }
    })
  },

  resetSessionUsage: () => {
    // 只清空用量统计，不清空 contextBreakdown；
    // 切换会话后 AgentLoop 会通过 injectHistory 重新推送新的上下文拆分。
    set({ sessionUsage: null })
  },

  setContextBreakdown: (payload) => {
    set({ contextBreakdown: payload })
  },

  syncFromWorkspace: (project: string | null, mode: Mode) => {
    // 仅在值真正变化时 set，避免无谓的重渲染
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

/** 重置整个 settings store 到默认值。供测试 setup 复用。 */
export function resetSettingsStoreForTests(): void {
  useSettingsStore.setState({
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
