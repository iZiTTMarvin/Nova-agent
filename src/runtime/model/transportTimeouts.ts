/**
 * 传输超时：首字超时随思考强度与服务商档案放宽，建连与语义事件间空闲保持默认。
 * 高思考强度下首字前可能静默数分钟，而心跳不算进展，固定 60 秒会误杀正常请求。
 */
import { DEFAULT_TRANSPORT_TIMEOUTS, type ModelTransportTimeouts } from './ModelTransport'
import type { CacheProfileId } from './cacheProfile'
import type { ReasoningEffort } from '../../shared/config/types'

const FIRST_BYTE_MS_BY_EFFORT: Readonly<Record<ReasoningEffort, number>> = {
  auto: 60_000,
  low: 60_000,
  medium: 90_000,
  high: 150_000,
  xhigh: 210_000,
  max: 270_000
}

/** 思考期间不回传 reasoning（或无法确认）的档案完全静默，额外放宽 */
const FIRST_BYTE_PROFILE_FACTOR: Readonly<Record<CacheProfileId, number>> = {
  anthropic: 1,
  deepseek: 1,
  kimi: 1,
  glm: 1,
  minimax: 1,
  openai: 1.25,
  generic: 1.25
}

export function resolveTransportTimeouts(
  reasoningEffort: ReasoningEffort,
  profileId: CacheProfileId
): ModelTransportTimeouts {
  return {
    connectMs: DEFAULT_TRANSPORT_TIMEOUTS.connectMs,
    firstByteMs: Math.ceil(FIRST_BYTE_MS_BY_EFFORT[reasoningEffort] * FIRST_BYTE_PROFILE_FACTOR[profileId]),
    idleMs: DEFAULT_TRANSPORT_TIMEOUTS.idleMs
  }
}
