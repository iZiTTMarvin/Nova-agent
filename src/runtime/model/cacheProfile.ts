/**
 * CacheProfile — provider 缓存能力的唯一判定来源（T1-1）
 *
 * 由 baseUrl + modelId + 用户显式覆盖解析有效档案。
 * 本轮只接线 marker（驱动 cache_control 注入）；其余字段类型已定义，
 * 供后续阶段消费：
 * - promptCacheKey → T1-4 会话路由 key
 * - reasoningReplay → T2 reasoning 回放
 * - idlePolicy / minCacheableTokens → T3 压缩与空闲策略
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
  /** T1-4 接线：是否在请求体携带会话级 prompt_cache_key */
  promptCacheKey: 'never' | 'session'
  /** T2 接线：历史 reasoning_content 回放范围 */
  reasoningReplay: 'none' | 'tool-call-history' | 'all-history'
  /** T3 接线：低于此 token 数时不指望前缀缓存收益 */
  minCacheableTokens?: number
  /** T3 接线：空闲压缩 / TTL 相关策略 */
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
    idlePolicy: 'anthropic-short-ttl'
  },
  deepseek: {
    id: 'deepseek',
    marker: 'none',
    promptCacheKey: 'never',
    reasoningReplay: 'tool-call-history',
    idlePolicy: 'provider-managed'
  },
  kimi: {
    id: 'kimi',
    marker: 'none',
    promptCacheKey: 'session',
    reasoningReplay: 'all-history',
    idlePolicy: 'provider-managed'
  },
  glm: {
    id: 'glm',
    marker: 'none',
    promptCacheKey: 'never',
    reasoningReplay: 'none',
    idlePolicy: 'provider-managed'
  },
  minimax: {
    id: 'minimax',
    marker: 'none',
    promptCacheKey: 'never',
    reasoningReplay: 'none',
    idlePolicy: 'provider-managed'
  },
  openai: {
    id: 'openai',
    marker: 'none',
    promptCacheKey: 'session',
    reasoningReplay: 'none',
    idlePolicy: 'provider-managed'
  },
  generic: {
    id: 'generic',
    marker: 'none',
    promptCacheKey: 'never',
    reasoningReplay: 'none',
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
  { host: 'minimax.chat', id: 'minimax' },
  { host: 'minimax.io', id: 'minimax' },
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
