/**
 * 可关闭的结构化运行指标
 *
 * 只记录类别 / 大小 / 时间，不记录 prompt、密钥、文件内容。
 * 默认关闭；设环境变量 NOVA_METRICS=1 开启。
 *
 * 用途：长任务改造前后对比 attempt 次数、TTFT、append 耗时、readState 字节数；
 * 以及按逻辑请求 / 物理 attempt / 路由 / 用途分账的传输与用量观测。
 *
 * 口径约束：
 * - 指标是只读投影，不得反向成为历史、预算或 in-flight 状态源。
 * - 未发生的阶段不写数值键（缺键即不可用），不用 0 或 -1 冒充时间戳。
 * - 每条指标带启动身份，便于把记录分段到具体构建与启动周期。
 */
import { getLaunchIdentity } from './launchIdentity'

/** 安全读环境变量（renderer 可能无 process） */
function readEnv(name: string): string | undefined {
  try {
    return (typeof process !== 'undefined' && process.env?.[name]) || undefined
  } catch {
    return undefined
  }
}

/** 是否启用指标采集 */
export function isMetricsEnabled(): boolean {
  return readEnv('NOVA_METRICS') === '1'
}

/** 指标事件类别（可扩展，保持稳定字符串） */
export type MetricCategory =
  | 'attempt.start'
  | 'attempt.end'
  | 'attempt.ttft'
  /** 一次物理 HTTP attempt 的本地时序与终态（区别于 attempt.* 的逻辑请求口径） */
  | 'transport.attempt'
  | 'transport.dispatch'
  /** 一条模型上报（或缺失）的 usage；按用途与路由分账 */
  | 'usage.report'
  | 'usage.adoption'
  | 'session.append'
  | 'readState.set'
  | 'readState.evict'
  | 'readState.stats'
  | 'cache.first_diff'
  | 'cache.reuse_vs_actual'

export interface MetricEvent {
  /** 事件类别 */
  category: MetricCategory
  /** 单调时间戳（ms） */
  ts: number
  /** 可选关联 id（logicalRequestId / attemptId / sessionId / runId），不含敏感内容 */
  id?: string
  /** 数值字段：耗时 ms、字节数、次数等。未发生的阶段不写键。 */
  values: Record<string, number>
  /** 非敏感标签（如 errorClass、status、routeId、purpose） */
  tags?: Record<string, string>
  /** 产生该指标的启动 id */
  launchId: string
  /** 主 bundle 内容指纹；无法确定时为 'unknown' */
  buildFingerprint: string
  appVersion: string
  launchStartedAt: number
  host: import('./launchIdentity').LaunchHost
}

type MetricSink = (event: MetricEvent) => void

const sinks: MetricSink[] = []
const buffer: MetricEvent[] = []
const MAX_BUFFER = 500

/** 注册自定义 sink（测试 / 主进程日志） */
export function registerMetricSink(sink: MetricSink): () => void {
  sinks.push(sink)
  return () => {
    const idx = sinks.indexOf(sink)
    if (idx >= 0) sinks.splice(idx, 1)
  }
}

/** 清空缓冲与 sink（测试用） */
export function resetMetricsForTests(): void {
  buffer.length = 0
  sinks.length = 0
}

/** 读取最近缓冲（测试 / 诊断面板） */
export function getMetricBuffer(): readonly MetricEvent[] {
  return buffer
}

/**
 * 记录一条指标。未开启时为 no-op。
 * 禁止传入 prompt / apiKey / 文件正文。
 */
export function recordMetric(
  category: MetricCategory,
  values: Record<string, number>,
  opts?: { id?: string; tags?: Record<string, string> }
): void {
  if (!isMetricsEnabled()) return

  const launch = getLaunchIdentity()
  const event: MetricEvent = {
    category,
    ts: Date.now(),
    values,
    launchId: launch.launchId,
    buildFingerprint: launch.buildFingerprint,
    appVersion: launch.appVersion,
    launchStartedAt: launch.startedAt,
    host: launch.host,
    ...(opts?.id ? { id: opts.id } : {}),
    ...(opts?.tags ? { tags: opts.tags } : {})
  }

  buffer.push(event)
  if (buffer.length > MAX_BUFFER) buffer.shift()

  for (const sink of sinks) {
    try {
      sink(event)
    } catch {
      // sink 失败不影响主路径
    }
  }

  // 默认控制台输出（便于本地开启后观察）
  if (sinks.length === 0) {
    try {
      // eslint-disable-next-line no-console
      console.debug('[nova-metrics]', event)
    } catch {
      /* ignore */
    }
  }
}

/** 便捷：记录 attempt 开始 */
export function metricAttemptStart(attemptId: string): void {
  recordMetric('attempt.start', { count: 1 }, { id: attemptId })
}

/** 便捷：记录 TTFT（首 token 耗时 ms） */
export function metricAttemptTtft(attemptId: string, ttftMs: number): void {
  recordMetric('attempt.ttft', { ttftMs }, { id: attemptId })
}

/** 便捷：记录 attempt 结束 */
export function metricAttemptEnd(
  attemptId: string,
  durationMs: number,
  status: string
): void {
  recordMetric('attempt.end', { durationMs }, { id: attemptId, tags: { status } })
}

/** 便捷：记录 session append 耗时与消息数 */
export function metricSessionAppend(
  sessionId: string,
  durationMs: number,
  messageCount: number
): void {
  recordMetric('session.append', { durationMs, messageCount }, { id: sessionId })
}

/** 便捷：记录 readState 写入后的字节预算快照 */
export function metricReadStateStats(entries: number, bytes: number, evictions = 0): void {
  recordMetric('readState.stats', { entries, bytes, evictions })
}

/**
 * 一次物理 HTTP attempt 的观测字段。
 * 全部为原语：由 runtime 侧的观测记录降级而来，shared 不反向依赖 runtime 类型。
 */
export interface TransportAttemptMetricFields {
  timestamps?: { dispatchedAt: number; headersAt?: number; firstSemanticAt?: number; lastSemanticAt?: number; abortRequestedAt?: number; settledAt?: number }
  runId?: string
  sessionId?: string
  /** 逻辑请求 id；一个逻辑请求可对应多次物理派发 */
  logicalRequestId: string
  physicalAttemptId: string
  /** 单次 chat 调用内的物理派发序号，从 1 开始 */
  dispatchIndexWithinCall: number
  purpose: string
  /** 无密钥路由身份串 */
  routeId: string
  outcome: string
  /** 触发本次派发的内层能力降级；首发为 'none' */
  downgrade: string
  /** 响应头中的网关请求 id；无则空串 */
  providerRequestId: string
  /** 模型是否报告 usage */
  usageReport: string
  /** 完整出站请求体 SHA-256（对账用） */
  wireBodyHash: string
  /** 规范化请求体指纹（前缀比较用），与 wireBodyHash 语义不同 */
  canonicalBodyHash: string
  wireBodyBytes: number
  /** 阶段耗时；不可用的阶段省略对应键，不写 0 */
  durations: {
    dispatchToHeadersMs?: number
    headersToFirstSemanticMs?: number
    firstSemanticToSettledMs?: number
    totalMs?: number
  }
  /** 原生 fetch 不暴露 DNS/TCP/TLS 分段事件，恒为 'unavailable' */
  connectBreakdown: 'unavailable'
}

/** 便捷：记录一次物理 attempt 的本地观测（不含正文、参数与凭据） */
export function metricTransportAttempt(fields: TransportAttemptMetricFields): void {
  recordMetric(
    'transport.attempt',
    {
      dispatchIndexWithinCall: fields.dispatchIndexWithinCall,
      wireBodyBytes: fields.wireBodyBytes,
      ...fields.timestamps,
      ...fields.durations
    },
    {
      id: fields.logicalRequestId,
      tags: {
        physicalAttemptId: fields.physicalAttemptId,
        runId: fields.runId ?? 'unavailable',
        sessionId: fields.sessionId ?? 'unavailable',
        purpose: fields.purpose,
        routeId: fields.routeId,
        outcome: fields.outcome,
        downgrade: fields.downgrade,
        providerRequestId: fields.providerRequestId,
        usageReport: fields.usageReport,
        wireBodyHash: fields.wireBodyHash,
        canonicalBodyHash: fields.canonicalBodyHash,
        connectBreakdown: fields.connectBreakdown
      }
    }
  )
}

/** 一条 usage 的观测字段。usageReport 为 missing 时数值不得被当作真实用量。 */
export interface UsageReportMetricFields {
  physicalAttemptId?: string
  logicalRequestId: string
  purpose: string
  routeId: string
  usageReport: 'reported' | 'missing'
  /** 缓存计数字段覆盖归类：reportedZero / reportedPositive / unreported */
  cacheCountCoverage: string
  promptTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
}

/** 便捷：记录一条模型上报（或缺失）的 usage，按用途与路由分账 */
export function metricUsageReport(fields: UsageReportMetricFields): void {
  recordMetric(
    'usage.report',
    {
      ...(fields.promptTokens !== undefined ? { promptTokens: fields.promptTokens } : {}),
      ...(fields.cacheReadTokens !== undefined ? { cacheReadTokens: fields.cacheReadTokens } : {}),
      ...(fields.cacheWriteTokens !== undefined ? { cacheWriteTokens: fields.cacheWriteTokens } : {}),
      ...(fields.outputTokens !== undefined ? { outputTokens: fields.outputTokens } : {})
    },
    {
      id: fields.logicalRequestId,
      tags: {
        physicalAttemptId: fields.physicalAttemptId ?? 'unavailable',
        purpose: fields.purpose,
        routeId: fields.routeId,
        usageReport: fields.usageReport,
        cacheCountCoverage: fields.cacheCountCoverage
      }
    }
  )
}

/** 仅记录消费者的采纳决定；用物理 id 连接 usage.report，不重复累计 token。 */
export function metricUsageAdoption(
  source: import('../model/types').UsageSource,
  adopted: boolean,
  stage: 'main-result' | 'compaction-context'
): void {
  recordMetric('usage.adoption', { adopted: adopted ? 1 : 0 }, {
    id: source.logicalRequestId,
    tags: { physicalAttemptId: source.physicalAttemptId, routeId: source.routeId, purpose: source.purpose, stage }
  })
}
