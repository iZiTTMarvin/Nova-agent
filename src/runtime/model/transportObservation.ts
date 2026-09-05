/** TransportAttemptObservation — 单次物理 HTTP attempt 的本地观测契约 */
import type { ChatRequestPurpose, UsageReport } from '../../shared/model/types'
import type { TransportAttemptMetricFields } from '../../shared/diagnostics/metrics'
import type { DowngradeCapability } from './types'
import type { RouteIdentity } from './routeIdentity'

/** 一次物理 attempt 的本地终态 */
export type TransportOutcome =
  /** 正常 EOF 结束 */
  | 'completed'
  /** 收到非 2xx 响应 */
  | 'http_error'
  /** 超时 / 网络错误 */
  | 'transport_error'
  /** 用户或上层取消 */
  | 'cancelled'
  /** 消费者提前退出，已本地结算，远端结果未知 */
  | 'abandoned'

/** 物理 attempt 的墙钟时间戳（ms）。 */
export interface TransportTiming {
  abortRequestedAt: number | null
  /** 本地派发 fetch 的时刻 */
  dispatchedAt: number
  /** 拿到响应对象（响应头已到）的时刻；派发前失败为 null */
  headersAt: number | null
  /** 首个模型语义事件的时刻；SSE comment / role / usage 不算语义 */
  firstSemanticAt: number | null
  /** 最近一个模型语义事件的时刻 */
  lastSemanticAt: number | null
  /** 本地终态（EOF / 错误 / 取消）时刻；未 settle 为 null */
  settledAt: number | null
  connectBreakdown: 'unavailable'
}

/** 由 timing 派生的分段耗时；对应阶段未发生时为 null。 */
export interface TransportDurations {
  /** 派发 → 响应头 */
  dispatchToHeadersMs: number | null
  /** 响应头 → 首个语义事件 */
  headersToFirstSemanticMs: number | null
  /** 首个语义事件 → 本地终态 */
  firstSemanticToSettledMs: number | null
  /** 派发 → 本地终态 */
  totalMs: number | null
}

export interface TransportAttemptObservation {
  /** 物理 attempt 唯一 id；同一逻辑请求的多次派发各不相同 */
  physicalAttemptId: string
  /** 单次 chat 调用内的物理派发序号，从 1 开始（能力降级重发递增） */
  dispatchIndexWithinCall: number
  /** 调用方声明的请求用途；未声明为 null，不由客户端猜测填充 */
  purpose: ChatRequestPurpose | null
  route: RouteIdentity
  outcome: TransportOutcome
  timing: TransportTiming
  durations: TransportDurations
  /** 完整出站请求体的 SHA-256（64 hex）。用于与代理/供应商侧原始请求对账， */
  wireBodyHash: string
  wireBodyBytes: number
  /** 规范化后请求体的缓存比较指纹（16 hex，Anthropic 会剥离滚动 cache_control）。 */
  canonicalBodyHash: string
  /** 触发本次物理派发的内层能力降级；首发为 null */
  downgrade: DowngradeCapability | null
  /** 响应头中的网关请求 id（仅诊断）；无则 null */
  providerRequestId: string | null
  /** 模型是否在本次响应中报告 usage；missing 不得按 0 用量解读 */
  usageReport: UsageReport
}

/** 派发时刻建立空时序；后续阶段由 TransportAttempt 单调填入。 */
export function createTransportTiming(dispatchedAt: number): TransportTiming {
  return {
    abortRequestedAt: null,
    dispatchedAt,
    headersAt: null,
    firstSemanticAt: null,
    lastSemanticAt: null,
    settledAt: null,
    connectBreakdown: 'unavailable'
  }
}

/** 由时序派生分段耗时（唯一实现）。阶段缺失时对应耗时为 null，不填 0。 */
export function deriveTransportDurations(timing: TransportTiming): TransportDurations {
  return {
    dispatchToHeadersMs: spanMs(timing.dispatchedAt, timing.headersAt),
    headersToFirstSemanticMs: spanMs(timing.headersAt, timing.firstSemanticAt),
    firstSemanticToSettledMs: spanMs(timing.firstSemanticAt, timing.settledAt),
    totalMs: spanMs(timing.dispatchedAt, timing.settledAt)
  }
}

function spanMs(from: number | null, to: number | null): number | null {
  if (from === null || to === null) return null
  return to - from
}

/** 把观测记录降级为指标字段（唯一实现，主对话与压缩消费者共用）。 */
export function toTransportAttemptMetric(
  observation: TransportAttemptObservation,
  opts: { logicalRequestId: string }
): TransportAttemptMetricFields {
  const durations: TransportAttemptMetricFields['durations'] = {}
  if (observation.durations.dispatchToHeadersMs !== null) {
    durations.dispatchToHeadersMs = observation.durations.dispatchToHeadersMs
  }
  if (observation.durations.headersToFirstSemanticMs !== null) {
    durations.headersToFirstSemanticMs = observation.durations.headersToFirstSemanticMs
  }
  if (observation.durations.firstSemanticToSettledMs !== null) {
    durations.firstSemanticToSettledMs = observation.durations.firstSemanticToSettledMs
  }
  if (observation.durations.totalMs !== null) {
    durations.totalMs = observation.durations.totalMs
  }

  return {
    logicalRequestId: opts.logicalRequestId,
    timestamps: {
      dispatchedAt: observation.timing.dispatchedAt,
      ...(observation.timing.headersAt !== null ? { headersAt: observation.timing.headersAt } : {}),
      ...(observation.timing.firstSemanticAt !== null ? { firstSemanticAt: observation.timing.firstSemanticAt } : {}),
      ...(observation.timing.lastSemanticAt !== null ? { lastSemanticAt: observation.timing.lastSemanticAt } : {}),
      ...(observation.timing.abortRequestedAt !== null ? { abortRequestedAt: observation.timing.abortRequestedAt } : {}),
      ...(observation.timing.settledAt !== null ? { settledAt: observation.timing.settledAt } : {})
    },
    physicalAttemptId: observation.physicalAttemptId,
    dispatchIndexWithinCall: observation.dispatchIndexWithinCall,
    purpose: observation.purpose ?? 'undeclared',
    routeId: observation.route.routeId,
    outcome: observation.outcome,
    downgrade: observation.downgrade ?? 'none',
    providerRequestId: observation.providerRequestId ?? '',
    usageReport: observation.usageReport,
    wireBodyHash: observation.wireBodyHash,
    canonicalBodyHash: observation.canonicalBodyHash,
    wireBodyBytes: observation.wireBodyBytes,
    durations,
    connectBreakdown: observation.timing.connectBreakdown
  }
}
