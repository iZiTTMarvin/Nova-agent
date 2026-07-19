/**
 * 归一化后的 token 用量统计
 * 统一 OpenAI / DeepSeek / Anthropic 三种 provider 的缓存字段差异
 */
export interface NormalizedUsage {
  promptTokens: number
  completionTokens: number
  /** 从缓存读取的 token 数（命中缓存的部分） */
  cachedTokens: number
  /** 写入缓存的 token 数（创建缓存的部分，仅 Anthropic 类 provider 有值） */
  cacheWriteTokens: number
  /**
   * 缓存未命中 token 数（DeepSeek 等返回 prompt_cache_miss_tokens 时有值）。
   * 必须 optional：多数 provider 不返回该字段，不能破坏现存对象字面量。
   */
  cacheMissTokens?: number
}
