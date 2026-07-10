/**
 * 模型配置类型
 * 全局唯一的 OpenAI-compatible 模型配置
 */

import { lookupModelCapability } from './modelRegistry'

/** 缓存策略：auto = 前缀稳定即自动命中；anthropic = 显式 cache_control 标记 */
export type CacheStrategy = 'auto' | 'anthropic'

/**
 * 缓存档案标识（与 runtime/model/cacheProfile.ts 对齐）。
 * 'auto' 表示交给 resolveCacheProfile 自动判定，不是档案本身。
 */
export type CacheProfileId =
  | 'anthropic'
  | 'deepseek'
  | 'kimi'
  | 'glm'
  | 'minimax'
  | 'openai'
  | 'generic'

export interface ModelConfig {
  baseUrl: string
  apiKey: string
  modelId: string
  /**
   * 缓存策略（兼容字段，保留不删）。默认 'auto'。
   * 'anthropic' 适用于 Anthropic 原生 API 或中转，会对最后 2 条消息打 cache_control 标记。
   * 新代码优先读 cacheProfile；未设置 cacheProfile 时仍尊重本字段。
   */
  cacheStrategy?: CacheStrategy
  /**
   * 缓存档案覆盖。默认 'auto'（按 baseUrl/modelId 判定，并兼容旧 cacheStrategy）。
   * 显式指定时优先于 cacheStrategy 与自动判定。
   */
  cacheProfile?: 'auto' | CacheProfileId
  /** 模型最大上下文窗口（tokens），未设置时从 modelId 自动推断 */
  contextWindow?: number
  /** 是否支持图片输入。未设置时按优先级查注册表→字符串兜底→默认 false（见 resolveSupportsVision） */
  supportsVision?: boolean
  /**
   * 备用模型配置链（fallback）。
   * 主模型出现 429/5xx 等瞬态错误且重试链耗尽时，按顺序切换到这些模型继续任务。
   * 第一个元素是第一顺位 fallback，依次类推。
   * 留空或未设置表示不启用降级（保持原行为）。
   */
  fallbacks?: ModelConfig[]
  /**
   * 工具调用方言覆盖。'auto'（默认）按 preferredToolDialect 自动判定；
   * 'native' 强制原生函数调用；'xml' 强制 inband XML 兜底。
   */
  toolDialect?: 'auto' | 'native' | 'xml'
  /**
   * 思考强度（reasoning effort）覆盖。
   * 缺省或 'auto' 时不发送该参数；'low'/'medium'/'high' 显式控制推理深度。
   * 运行时按 provider 方言注入 reasoning_effort（GLM 额外带 thinking 对象）。
   */
  reasoningEffort?: 'auto' | 'low' | 'medium' | 'high'
}

/** 从 baseUrl 推断默认缓存策略 */
export function inferCacheStrategy(baseUrl: string): CacheStrategy {
  const lower = baseUrl.toLowerCase()
  if (lower.includes('anthropic') || lower.includes('claude')) {
    return 'anthropic'
  }
  return 'auto'
}

/** 默认上下文窗口上限 */
const DEFAULT_CONTEXT_WINDOW = 200_000

/** 基于常见模型 ID 自动推断上下文窗口上限 */
export function inferContextWindow(modelId: string): number {
  const lower = modelId.toLowerCase()
  if (lower.includes('claude-3-opus')) return 200_000
  if (lower.includes('claude-3-5')) return 200_000
  if (lower.includes('claude-3')) return 200_000
  if (lower.includes('gpt-4o')) return 128_000
  if (lower.includes('gpt-4-turbo')) return 128_000
  if (lower.includes('gpt-4')) return 128_000
  if (lower.includes('deepseek')) return 64_000
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * 基于模型 ID 推断是否支持图片输入（vision）。
 * 策略偏保守：未知模型默认 false，避免误开上传按钮污染会话。
 * 当 ModelConfig.supportsVision 未设置时作为兜底推断。
 */
export function inferVisionSupport(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  if (!lower) return false

  // 显式纯文本标记
  if (lower.includes('text-only')) return false
  if (lower.includes('gpt-3.5')) return false

  // DeepSeek：仅 VL 变体支持视觉；v4-pro/flash/chat/reasoner 均为纯文本
  if (lower.includes('deepseek')) {
    return lower.includes('vl')
  }

  // 已知支持视觉的模型族 / 关键字
  if (lower.includes('mimo')) return true
  if (lower.includes('gpt-4o')) return true
  if (lower.includes('gpt-4.1')) return true
  if (lower.includes('gpt-4-turbo')) return true
  if (lower.includes('gpt-4-vision')) return true
  if (lower.includes('claude-3')) return true
  if (lower.includes('claude-4')) return true
  if (lower.includes('claude-sonnet')) return true
  if (lower.includes('claude-opus')) return true
  if (lower.includes('claude-haiku')) return true
  if (lower.includes('gemini')) return true
  if (lower.includes('glm-4v') || lower.includes('glm-4.1v') || lower.includes('glm-4.5v')) return true
  if (lower.includes('qwen-vl') || lower.includes('qwen2-vl') || lower.includes('qwen2.5-vl')) return true
  if (lower.includes('minimax')) return true
  // 通用 VL / vision 后缀
  if (lower.includes('-vl') || lower.includes('_vl') || lower.includes('vision')) return true

  // 未知模型：默认不开放视觉，避免误放行图片污染会话
  return false
}

/**
 * 解析模型是否支持图片输入，统一优先级链：
 *   1. 用户显式勾选 explicit（非 undefined 即采纳）
 *   2. 精确注册表 MODEL_CAPABILITY_REGISTRY
 *   3. 字符串模糊兜底 inferVisionSupport
 *   4. 默认 false
 */
export function resolveSupportsVision(modelId: string, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit
  const entry = lookupModelCapability(modelId)
  if (entry?.supportsVision !== undefined) return entry.supportsVision
  return inferVisionSupport(modelId)
}
