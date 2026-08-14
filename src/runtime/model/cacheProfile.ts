/**
 * CacheProfile — provider 缓存能力的唯一判定来源
 *
 * 由 baseUrl + modelId + 用户显式覆盖解析有效档案。各字段消费方：
 * - marker → cache_control 注入（messageFormat）
 * - promptCacheKey → 会话缓存路由 key 注入（OpenAICompatibleModelClient）
 * - reasoningReplay / reasoningWire → 历史 reasoning 回放（toApiMessage）
 * - idlePolicy → 空闲压缩资格（shouldScheduleIdleCompaction）
 * - minCacheableTokens 暂无消费方，预留
 *
 * 判定风格对齐 dialect.ts 的 preferredToolDialect（域名片段 + modelId 分词）。
 */
import type { CacheProfileId, CacheStrategy } from '../../shared/config/types'

export type { CacheProfileId }

/** 请求体缓存标记策略：仅 anthropic 注入 cache_control */
export type CacheMarker = 'cache_control' | 'none'

export interface CacheProfile {
  id: CacheProfileId
  marker: CacheMarker
  /** 接线：是否在请求体携带会话级 prompt_cache_key */
  promptCacheKey: 'never' | 'session'
  /** 历史 reasoning_content 回放范围 */
  reasoningReplay: 'none' | 'tool-call-history' | 'all-history'
  /**
   * reasoning 回放载体：
   * - 'reasoning_content'：assistant 消息带独立 reasoning_content 字段（DeepSeek / Kimi / GLM）
   * - 'reasoning'：同上但字段名为 reasoning（部分 provider 端点变体）
   * - 'think-tag'：注回 content 开头的 <think>…</think>（MiniMax OpenAI 兼容端点
   *   不识别请求侧 reasoning_content 字段，官方要求 content 中完整保留 think 标签）
   */
  reasoningWire: 'reasoning_content' | 'reasoning' | 'think-tag'
  /**
   * 为 true 时，实际使用的 reasoning 字段由首次响应观测决定，初始值取 reasoningWire。
   * 观测结果存在 client 实例态（不写回本静态表），且允许被后续响应覆盖。
   * 已知局限（接受，不在本阶段解决）：新建 client 实例会丢失观测，需一次请求重新学习；
   * 不跨进程持久化。
   */
  reasoningWireObservable?: boolean
  /** 低于此 token 数时不指望前缀缓存收益 */
  minCacheableTokens?: number
  /** 空闲压缩 / TTL 相关策略 */
  idlePolicy: 'anthropic-short-ttl' | 'provider-managed' | 'unknown'
}

/** resolveCacheProfile 的可选覆盖（显式 profile + 旧 cacheStrategy 兼容） */
export interface ResolveCacheProfileOverride {
  /** ModelConfig.cacheProfile；'auto'/缺省表示不强制 */
  cacheProfile?: 'auto' | CacheProfileId
  /** 旧字段兼容：仅 'anthropic' 强制 anthropic 档案；'auto' 强制 generic（marker:none） */
  cacheStrategy?: CacheStrategy
}

/** 各档案的静态能力表 */
const PROFILES: Record<CacheProfileId, CacheProfile> = {
  anthropic: {
    id: 'anthropic',
    marker: 'cache_control',
    promptCacheKey: 'never',
    reasoningReplay: 'none',
    reasoningWire: 'reasoning_content',
    idlePolicy: 'anthropic-short-ttl'
  },
  deepseek: {
    id: 'deepseek',
    marker: 'none',
    promptCacheKey: 'never',
    reasoningReplay: 'tool-call-history',
    reasoningWire: 'reasoning_content',
    idlePolicy: 'provider-managed'
  },
  kimi: {
    id: 'kimi',
    marker: 'none',
    promptCacheKey: 'session',
    reasoningReplay: 'all-history',
    reasoningWire: 'reasoning_content',
    // Kimi 实际 reasoning 字段由首次响应观测决定（reasoning_content / reasoning 两种端点变体）
    reasoningWireObservable: true,
    idlePolicy: 'provider-managed'
  },
  glm: {
    id: 'glm',
    marker: 'none',
    promptCacheKey: 'never',
    reasoningReplay: 'all-history',
    reasoningWire: 'reasoning_content',
    idlePolicy: 'provider-managed'
  },
  minimax: {
    id: 'minimax',
    marker: 'none',
    promptCacheKey: 'never',
    // M2/M3 为交错思维链模型：官方要求全量历史保留思考，否则模型退化为只输出摘要式标题
    reasoningReplay: 'all-history',
    reasoningWire: 'think-tag',
    idlePolicy: 'provider-managed'
  },
  openai: {
    id: 'openai',
    marker: 'none',
    promptCacheKey: 'session',
    reasoningReplay: 'none',
    reasoningWire: 'reasoning_content',
    idlePolicy: 'provider-managed'
  },
  generic: {
    id: 'generic',
    marker: 'none',
    promptCacheKey: 'never',
    reasoningReplay: 'none',
    reasoningWire: 'reasoning_content',
    idlePolicy: 'unknown'
  }
}

/** 官方/主流 API 域名 → 档案（openrouter 聚合站单独处理） */
const OFFICIAL_HOST_PROFILES: Array<{ host: string; id: CacheProfileId }> = [
  { host: 'anthropic.com', id: 'anthropic' },
  { host: 'anthropic', id: 'anthropic' },
  { host: 'deepseek.com', id: 'deepseek' },
  { host: 'moonshot.cn', id: 'kimi' },
  { host: 'moonshot.ai', id: 'kimi' },
  { host: 'bigmodel.cn', id: 'glm' },
  { host: 'z.ai', id: 'glm' },
  { host: 'minimax.chat', id: 'minimax' },
  { host: 'minimax.io', id: 'minimax' },
  { host: 'minimaxi.com', id: 'minimax' },
  { host: 'openai.com', id: 'openai' }
]

/** modelId 分词命中的家族 → 档案 */
const MODEL_TOKEN_PROFILES: Record<string, CacheProfileId> = {
  claude: 'anthropic',
  anthropic: 'anthropic',
  deepseek: 'deepseek',
  kimi: 'kimi',
  moonshot: 'kimi',
  glm: 'glm',
  chatglm: 'glm',
  minimax: 'minimax',
  abab: 'minimax',
  gpt: 'openai',
  o1: 'openai',
  o3: 'openai',
  o4: 'openai'
}

/** OpenRouter 等聚合站：modelId 形如 `anthropic/claude-...` 时取 provider 前缀 */
const AGGREGATOR_HOSTS = ['openrouter.ai', 'openrouter.com'] as const

/**
 * 解析有效 CacheProfile。
 *
 * 优先级：
 * 1. cacheProfile 显式覆盖（非 auto）
 * 2. 旧 cacheStrategy:'anthropic' → 完整 anthropic 档案
 * 3. 按 baseUrl/modelId 自然归属（含 'auto'/缺省）
 * 4. cacheStrategy:'auto' 仅在自然归属 marker 为 cache_control 时压成 none 副本，
 *    不替换整个 profile（保留 reasoningReplay / promptCacheKey / idlePolicy）
 */
export function resolveCacheProfile(
  baseUrl: string,
  modelId: string,
  override?: ResolveCacheProfileOverride
): CacheProfile {
  const explicit = override?.cacheProfile
  if (explicit && explicit !== 'auto' && PROFILES[explicit]) {
    return PROFILES[explicit]
  }

  // 旧 cacheStrategy:'anthropic'：完整向后兼容
  if (override?.cacheStrategy === 'anthropic') {
    return PROFILES.anthropic
  }

  // 'auto' / 缺省：按 URL/modelId 自然归属
  const profile = PROFILES[detectProfileId(baseUrl, modelId)]

  // cacheStrategy:'auto' 残留语义：明确不要 cache_control 断点，但不钉死为 generic
  if (override?.cacheStrategy === 'auto' && profile.marker === 'cache_control') {
    return { ...profile, marker: 'none' }
  }

  return profile
}

/** 按 marker 取档案（供仅知 marker 的测试/兼容路径） */
export function profileForMarker(marker: CacheMarker): CacheProfile {
  return marker === 'cache_control' ? PROFILES.anthropic : PROFILES.generic
}

/** 导出只读档案表，便于单测断言字段完整性 */
export function getCacheProfileCatalog(): Readonly<Record<CacheProfileId, CacheProfile>> {
  return PROFILES
}

function detectProfileId(baseUrl: string, modelId: string): CacheProfileId {
  const lowerUrl = (baseUrl ?? '').toLowerCase()
  const tokens = tokenizeModelId(modelId)

  // 聚合站：优先用 modelId 的 provider/model 前缀
  if (AGGREGATOR_HOSTS.some(h => lowerUrl.includes(h))) {
    const fromPrefix = profileFromAggregatorModelId(modelId)
    if (fromPrefix) return fromPrefix
    const fromTokens = profileFromTokens(tokens)
    if (fromTokens) return fromTokens
    return 'generic'
  }

  // modelId 分词
  const fromTokens = profileFromTokens(tokens)
  if (fromTokens) return fromTokens

  // 官方域名
  for (const { host, id } of OFFICIAL_HOST_PROFILES) {
    if (lowerUrl.includes(host)) return id
  }

  return 'generic'
}

function tokenizeModelId(modelId: string): string[] {
  return modelId
    .toLowerCase()
    .replace(/[-_:./]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function profileFromTokens(tokens: string[]): CacheProfileId | null {
  for (const token of tokens) {
    const id = MODEL_TOKEN_PROFILES[token]
    if (id) return id
    // MiniMax 历史型号如 abab6.5s → 分词后为 abab6 / 5s
    if (token.startsWith('abab')) return 'minimax'
  }
  return null
}

/** 解析 `provider/model` 或 `provider.model` 形式的聚合站 modelId */
function profileFromAggregatorModelId(modelId: string): CacheProfileId | null {
  const lower = modelId.toLowerCase()
  const slash = lower.indexOf('/')
  const prefix = slash >= 0 ? lower.slice(0, slash) : ''
  if (!prefix) return null

  if (prefix === 'anthropic' || prefix === 'claude') return 'anthropic'
  if (prefix === 'deepseek') return 'deepseek'
  if (prefix === 'moonshot' || prefix === 'kimi') return 'kimi'
  if (prefix === 'z-ai' || prefix === 'zhipu' || prefix === 'glm' || prefix.includes('glm')) {
    return 'glm'
  }
  if (prefix === 'minimax') return 'minimax'
  if (prefix === 'openai') return 'openai'
  return null
}
