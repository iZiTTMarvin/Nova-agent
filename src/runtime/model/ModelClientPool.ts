/**
 * ModelClientPool — 主模型 + fallback 模型的 client 集合（PRD §5.4）
 *
 * 设计：
 * - 持有主 client 与 fallback clients 数组。
 * - 实现 ModelClient 接口，chat() 委托给当前 active client。
 * - 暴露 switchToFallback(index) / getActiveProvider() / getFallbackCount() 供 AgentLoop 在
 *   重试链耗尽后由 FallbackDecider 决定切换时调用。
 *
 * 与 AgentLoop 的协作：
 * - AgentLoop 持有 ModelClientPool 实例（替代单个 ModelClient）。
 * - chat() 流的 error 事件到达时，AgentLoop 先走 RecoveryStateMachine 重试链；
 *   重试耗尽且 FallbackDecider 判定 shouldFallback 后，调用 switchToFallback()，
 *   重置 modelErrorAttempt，对新模型重新开始重试链，再继续外层循环。
 * - 不在 pool 内部自动切换：切换决策权属于 AgentLoop（保持单一职责）。
 */
import type { ChatMessage, ChatEvent, ToolDefinition } from '../model/types'
import type { ModelClient, ChatOptions } from './ModelClient'
import type { ModelConfig } from '../../shared/config'

/** 单个 provider 槽位：config + 已创建的 client */
interface ProviderSlot {
  config: ModelConfig
  client: ModelClient
  /** 是否是主模型（index 0） */
  isPrimary: boolean
}

/** 活跃 provider 信息（供 UI 展示与方言/缓存档案判定） */
export interface ActiveProviderInfo {
  /** 当前使用的模型 ID */
  modelId: string
  /** 当前是主模型还是第 N 个 fallback（0=主，1+=第 N fallback） */
  fallbackIndex: number
  /** baseUrl，供 UI 展示来源 */
  baseUrl: string
  /** 用户配置的工具调用方言覆盖（'auto' 或未设置时走自动判定） */
  toolDialect?: ModelConfig['toolDialect']
  /** 显式缓存档案覆盖，交给 resolveCacheProfile */
  cacheProfile?: ModelConfig['cacheProfile']
  /** 旧 cacheStrategy 兼容字段 */
  cacheStrategy?: ModelConfig['cacheStrategy']
}

export interface ModelClientPoolOptions {
  /** 主模型 client（必须） */
  primary: ModelClient
  /** 主模型配置（用于 getActiveProvider） */
  primaryConfig: ModelConfig
  /** fallback 模型配置 + 对应 client 工厂结果 */
  fallbacks?: Array<{ config: ModelConfig; client: ModelClient }>
}

export class ModelClientPool implements ModelClient {
  /** 所有 provider 槽位：index 0 是主模型，1+ 是 fallback */
  private readonly slots: ProviderSlot[] = []
  /** 当前 active 的 slot 索引 */
  private activeIndex = 0
  /**
   * 本轮（pool 生命周期）已禁用的能力集合。
   *
   * pool 每个 turn 新建一次，故该集合天然按 turn 隔离：并发 turn 各自的 pool 互不影响。
   * 通过 ChatOptions.capabilityDisabled 透传给底层 client，使其请求体计算读取该集合，
   * 而非共享的 client 实例态。
   */
  private readonly disabledCapabilities = new Set<string>()

  constructor(opts: ModelClientPoolOptions) {
    this.slots.push({ config: opts.primaryConfig, client: opts.primary, isPrimary: true })
    if (opts.fallbacks) {
      for (const fb of opts.fallbacks) {
        this.slots.push({ config: fb.config, client: fb.client, isPrimary: false })
      }
    }
  }

  /** 实现 ModelClient.chat：委托给当前 active client，透传本轮禁用能力集合 */
  chat(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): AsyncIterable<ChatEvent> {
    const merged: ChatOptions = {
      ...(options ?? {}),
      capabilityDisabled: this.disabledCapabilities
    }
    return this.slots[this.activeIndex].client.chat(messages, tools, merged)
  }

  /** 实现 ModelClient.updateConfig：只更新主模型配置（fallback 配置在创建时固定） */
  updateConfig(config: ModelConfig): void {
    this.slots[0].client.updateConfig(config)
    this.slots[0].config = config
  }

  /**
   * 切换到指定 fallback 索引。
   * @param index 0=主模型，1+=第 N 个 fallback
   * @throws 索引越界时抛错
   */
  switchToFallback(index: number): void {
    if (index < 0 || index >= this.slots.length) {
      throw new Error(`fallback 索引越界: ${index}（共 ${this.slots.length} 个 provider）`)
    }
    this.activeIndex = index
  }

  /** 重置回主模型（每个新会话/新消息轮次开始时调用） */
  resetToPrimary(): void {
    this.activeIndex = 0
  }

  /** 当前是否在使用主模型 */
  isPrimary(): boolean {
    return this.activeIndex === 0
  }

  /** 当前 active 的 fallback 索引（0=主） */
  getActiveFallbackIndex(): number {
    return this.activeIndex
  }

  /** 配置的 fallback 数量（不含主模型） */
  getFallbackCount(): number {
    return this.slots.length - 1
  }

  /** 是否启用了 fallback（至少配置了一个） */
  hasFallback(): boolean {
    return this.slots.length > 1
  }

  /** 当前 active provider 信息（供 UI 展示与日志） */
  getActiveProvider(): ActiveProviderInfo {
    const slot = this.slots[this.activeIndex]
    return {
      modelId: slot.config.modelId,
      fallbackIndex: this.activeIndex,
      baseUrl: slot.config.baseUrl,
      toolDialect: slot.config.toolDialect,
      cacheProfile: slot.config.cacheProfile,
      cacheStrategy: slot.config.cacheStrategy
    }
  }
}
