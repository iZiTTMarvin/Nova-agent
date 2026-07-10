/**
 * 可关闭的结构化运行指标（T0-4）
 *
 * 只记录类别 / 大小 / 时间，不记录 prompt、密钥、文件内容。
 * 默认关闭；设环境变量 NOVA_METRICS=1 开启。
 *
 * 用途：长任务改造前后对比 attempt 次数、TTFT、append 耗时、readState 字节数。
 */

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
  | 'session.append'
  | 'readState.set'
  | 'readState.evict'
  | 'readState.stats'

export interface MetricEvent {
  /** 事件类别 */
  category: MetricCategory
  /** 单调时间戳（ms） */
  ts: number
  /** 可选关联 id（attemptId / sessionId / runId），不含敏感内容 */
  id?: string
  /** 数值字段：耗时 ms、字节数、次数等 */
  values: Record<string, number>
  /** 非敏感标签（如 errorClass、status） */
  tags?: Record<string, string>
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

  const event: MetricEvent = {
    category,
    ts: Date.now(),
    values,
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
      console.debug('[nova-metrics]', event.category, event.values, event.tags ?? '', event.id ?? '')
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
