/**
 * useSettingsStore — 模型配置、UI 开关、当前项目/模式、用量统计
 *
 * 负责：
 * - ModelConfig 加载与保存
 * - isConfigModalOpen（设置弹窗显隐）
 * - currentProject / currentMode（工作区与运行模式）
 * - sessionUsage（会话级 token 用量聚合）
 *
 * 依赖方向：
 * - 不依赖 useChatStore / useAgentStore
 * - 被 useChatStore（sendMessage 读取 currentProject）和 useAgentStore 读取
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
  /** 当前工作区路径 */
  currentProject: string | null
  currentMode: Mode
  /** 当前会话的 token 用量聚合统计 */
  sessionUsage: SessionUsageStats | null
  /** 设置页「使用技能」后预填到 composer 的文本 */
  composerPrefill: string | null

  // ── Actions ──
  /** 加载持久化的模型配置 */
  loadModelConfig: () => Promise<void>
  /** 保存新模型配置 */
  saveModelConfig: (config: ModelConfig) => Promise<void>
  /** 打开或关闭配置弹窗 */
  setConfigModalOpen: (isOpen: boolean) => void
  /** 加载或切换工作区 */
  selectProject: () => Promise<void>
  /** 更换当前运行模式 */
  setMode: (mode: Mode) => Promise<void>
  /** 累计一次 token 用量 */
  handleUsage: (usage: NormalizedUsage) => void
  /** 切换会话时清空用量统计 */
  resetSessionUsage: () => void
  /** 手动设置 currentProject（被 ChatStore 创建/删除/切换会话时同步调用） */
  setCurrentProject: (project: string | null) => void
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

export const useSettingsStore = create<SettingsState>((set, get) => ({
  modelConfig: null,
  contextLimit: 200_000,
  isConfigModalOpen: false,
  currentProject: null,
  currentMode: 'default',
  sessionUsage: null,
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
    try {
      const selectedPath = await window.api.invoke('select-project')
      if (selectedPath) {
        // 通过 IPC 创建后端管理的真实会话
        const sessionDetail = await window.api.invoke('create-session', {
          workspaceRoot: selectedPath,
          mode: get().currentMode
        })

        // 通知 chat store 切到新会话
        // 通过动态 import 避免循环依赖
        const { useChatStore } = await import('./useChatStore')
        await useChatStore.getState().selectSession(sessionDetail.id)

        set({
          currentProject: selectedPath,
          currentMode: sessionDetail.mode
        })
      }
    } catch (err) {
      console.error('选择项目工作区失败:', err)
    }
  },

  setMode: async (mode: Mode) => {
    try {
      // 从 chat store 读取 currentSessionId 与 sessions（动态 import 避免循环依赖）
      const { useChatStore } = await import('./useChatStore')
      const { currentSessionId: sessionId, sessions } = useChatStore.getState()

      await window.api.invoke('set-mode', { mode, sessionId: sessionId ?? undefined })
      set({ currentMode: mode })

      // 更新当前会话的模式属性
      if (sessionId) {
        useChatStore.setState({
          sessions: sessions.map(s =>
            s.id === sessionId ? { ...s, mode } : s
          )
        })
      }
    } catch (err) {
      console.error('切换模式失败:', err)
    }
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
    set({ sessionUsage: null })
  },

  setCurrentProject: (project: string | null) => {
    set({ currentProject: project })
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
    composerPrefill: null
  })
}
