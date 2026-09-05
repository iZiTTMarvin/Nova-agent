import { resolveContextWindow } from '../../shared/config/types'
/** RouteIdentity — 无密钥的实际路由身份 */
import type { CacheProfileId, ModelRouteRef } from '../../shared/config/types'
import { createHash } from 'crypto'
import { resolveCacheProfile } from './cacheProfile'
import type { CacheStrategy } from '../../shared/config/types'

/** Nova 侧 OpenAI-compatible 协议适配版本；出站 wire 形状发生不兼容变化时递增。 */
export const OPENAI_COMPATIBLE_PROTOCOL_VERSION = 1

/** tokenizer 身份；当前无法从配置可靠推断，恒为 unknown，不得按模型家族名伪造。 */
export type TokenizerIdentity = 'unknown'

/** 解析路由身份所需的最小配置面（不含凭据） */
export interface RouteIdentitySource {
  baseUrl: string
  modelId: string
  routeRef?: ModelRouteRef
  connectionRevision?: string
  cacheProfile?: 'auto' | CacheProfileId
  cacheStrategy?: CacheStrategy
  reasoningEffort?: string
  contextWindow?: number
  toolDialect?: string
}

export interface RouteIdentity {
  /** 稳定可比较的身份串；用于观测分段与锚点兼容性判断 */
  routeId: string
  /** 注册表稳定引用；ad-hoc 配置为 null，不由 baseUrl 反推 */
  providerRef: ModelRouteRef | null
  /** 端点主机（去凭据、去查询串）；无法解析时为 'invalid' */
  endpointHost: string
  /** 实际写入请求体的 model 字段 */
  wireModel: string
  /** 协议能力档案；同档案不同端点仍是不同 route */
  cacheProfileId: CacheProfileId
  protocolVersion: number
  tokenizerId: TokenizerIdentity
}

/** 从当前调用的配置快照解析路由身份，不读取凭据。 */
export function resolveRouteIdentity(source: RouteIdentitySource): RouteIdentity {
  const cacheProfileId = resolveCacheProfile(source.baseUrl, source.modelId, {
    cacheProfile: source.cacheProfile,
    cacheStrategy: source.cacheStrategy
  }).id
  const providerRef = source.routeRef ?? null
  const endpointHost = extractEndpointHost(source.baseUrl)
  const refPart = providerRef
    ? `${providerRef.providerId}/${providerRef.modelEntryId}`
    : 'adhoc'

  return {
    routeId: [
      refPart,
      source.connectionRevision ?? 'legacy-connection',
      endpointHost,
      endpointIdentity(source.baseUrl),
      source.modelId,
      source.reasoningEffort ?? 'auto',
      String(resolveContextWindow(source.modelId, source.contextWindow)),
      source.toolDialect ?? 'auto',
      cacheProfileId,
      `proto${OPENAI_COMPATIBLE_PROTOCOL_VERSION}`,
      'tok-unknown'
    ].join('|'),
    providerRef,
    endpointHost,
    wireModel: source.modelId,
    cacheProfileId,
    protocolVersion: OPENAI_COMPATIBLE_PROTOCOL_VERSION,
    tokenizerId: 'unknown'
  }
}

function endpointIdentity(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    return createHash('sha256').update(`${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`).digest('hex')
  } catch {
    return 'invalid'
  }
}

function extractEndpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return 'invalid'
  }
}
