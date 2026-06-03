/**
 * 缓存破坏检测模块（参考 Claude Code 的 promptCacheBreakDetection）
 *
 * 通过记录 system prompt 和工具定义的哈希基线，
 * 在每次 API 响应后检查 cache_read_tokens 是否大幅下降，
 * 从而发现和诊断缓存意外失效的原因。
 */
import { createHash } from 'crypto'
import type { ToolDefinition } from './types'

/** 缓存诊断基线 */
interface CacheBaseline {
  /** system prompt 内容的 SHA-256 哈希 */
  systemPromptHash: string
  /** 工具定义排序列表的 SHA-256 哈希 */
  toolSchemaHash: string
  /** 上一轮的 cache_read_input_tokens（归一化后的 cachedTokens） */
  lastCacheReadTokens: number
  /** 基线创建时间戳 */
  createdAt: number
}

/** 缓存破坏检测结果 */
export interface CacheDiagnosticResult {
  /** 是否检测到缓存破坏 */
  cacheBreakDetected: boolean
  /** 破坏原因 */
  reason?: CacheBreakReason
  /** 建议 */
  suggestion?: string
  /** 当前 cache_read_tokens 相比上轮的变化量 */
  tokenDelta?: number
}

type CacheBreakReason =
  | 'system_prompt_changed'
  | 'tool_schema_changed'
  | 'significant_cache_read_drop'

/** cache_read_tokens 下降超过此比例视为显著（5%） */
const SIGNIFICANT_DROP_RATIO = 0.05
/** cache_read_tokens 下降的最小绝对阈值，避免小数值误报 */
const MIN_CACHE_MISS_TOKENS = 500

/**
 * 缓存诊断跟踪器
 *
 * 使用方式：
 * 1. 每次 API 请求前调用 recordBaseline()
 * 2. 每次 API 响应后调用 checkResponse()
 * 3. 压缩后调用 resetBaseline()
 */
export class CacheDiagnostics {
  private baseline: CacheBaseline | null = null

  /**
   * 记录当前请求的基线（在发送 API 请求前调用）
   * 保留上轮的 lastCacheReadTokens，用于跨轮次检测 cache_read 下降
   */
  recordBaseline(
    systemPrompt: string,
    tools: ToolDefinition[] | undefined
  ): void {
    const prevLastRead = this.baseline?.lastCacheReadTokens ?? 0
    this.baseline = {
      systemPromptHash: hashContent(systemPrompt),
      toolSchemaHash: hashToolSchemas(tools),
      lastCacheReadTokens: prevLastRead,
      createdAt: Date.now()
    }
  }

  /**
   * 检查 API 响应是否存在缓存破坏（在收到 usage 事件后调用）
   *
   * @param cachedTokens 本轮的 cache_read_input_tokens（归一化后的 cachedTokens）
   * @param currentSystemPrompt 当前实际使用的 system prompt
   * @param currentTools 当前实际使用的工具定义
   * @returns 诊断结果
   */
  checkResponse(
    cachedTokens: number,
    currentSystemPrompt: string,
    currentTools: ToolDefinition[] | undefined
  ): CacheDiagnosticResult {
    if (!this.baseline) {
      // 没有基线，跳过检测
      return { cacheBreakDetected: false }
    }

    // 检查 system prompt 是否变化
    const currentSystemHash = hashContent(currentSystemPrompt)
    if (currentSystemHash !== this.baseline.systemPromptHash) {
      const result: CacheDiagnosticResult = {
        cacheBreakDetected: true,
        reason: 'system_prompt_changed',
        suggestion: '系统提示在请求间发生了变化，导致缓存前缀不匹配。请检查是否有代码路径在会话中修改了 system prompt。',
        tokenDelta: cachedTokens - this.baseline.lastCacheReadTokens
      }
      this.updateReadTokens(cachedTokens)
      return result
    }

    // 检查工具定义是否变化
    const currentToolHash = hashToolSchemas(currentTools)
    if (currentToolHash !== this.baseline.toolSchemaHash) {
      const result: CacheDiagnosticResult = {
        cacheBreakDetected: true,
        reason: 'tool_schema_changed',
        suggestion: '工具定义在请求间发生了变化，导致缓存前缀不匹配。请检查是否有代码路径在会话中修改了工具注册。',
        tokenDelta: cachedTokens - this.baseline.lastCacheReadTokens
      }
      this.updateReadTokens(cachedTokens)
      return result
    }

    // 检查 cache_read 是否显著下降
    if (this.baseline.lastCacheReadTokens > 0) {
      const tokenDrop = this.baseline.lastCacheReadTokens - cachedTokens
      const dropRatio = tokenDrop / this.baseline.lastCacheReadTokens

      if (dropRatio > SIGNIFICANT_DROP_RATIO && tokenDrop > MIN_CACHE_MISS_TOKENS) {
        const result: CacheDiagnosticResult = {
          cacheBreakDetected: true,
          reason: 'significant_cache_read_drop',
          suggestion: `缓存命中率显著下降（${Math.round(dropRatio * 100)}%，${tokenDrop} tokens）。可能原因：上下文压缩、消息格式变化、或 API 侧缓存过期。`,
          tokenDelta: -tokenDrop
        }
        this.updateReadTokens(cachedTokens)
        return result
      }
    }

    this.updateReadTokens(cachedTokens)
    return { cacheBreakDetected: false }
  }

  /**
   * 压缩后重置基线（因为上下文完全改变，旧基线不再适用）
   */
  resetBaseline(
    systemPrompt: string,
    tools: ToolDefinition[] | undefined
  ): void {
    this.baseline = {
      systemPromptHash: hashContent(systemPrompt),
      toolSchemaHash: hashToolSchemas(tools),
      lastCacheReadTokens: 0,
      createdAt: Date.now()
    }
  }

  /** 更新记录的 cache_read_tokens */
  private updateReadTokens(cachedTokens: number): void {
    if (this.baseline) {
      this.baseline.lastCacheReadTokens = cachedTokens
    }
  }
}

/** 对内容计算 SHA-256 哈希 */
function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/** 对工具定义列表计算排序后的 SHA-256 哈希 */
function hashToolSchemas(tools: ToolDefinition[] | undefined): string {
  if (!tools || tools.length === 0) return 'no-tools'
  // 按名称排序确保注册顺序变化不影响哈希
  const sorted = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => `${t.name}:${t.description}:${JSON.stringify(t.parameters)}`)
    .join('|')
  return hashContent(sorted)
}
