import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import type {
  CodeContextPack,
  CodeContextQueryPort,
  CodeContextQueryRequest,
  CodeIndexSnapshot,
  CodeIndexStatus
} from '../runtime/code-graph'

export interface HeadlessCodeGraphDiagnostics {
  readonly enabled: boolean
  readonly call_count: number
  readonly query_latency_ms: {
    readonly total: number
    readonly max: number
    readonly average: number
    readonly p50: number
    readonly p95: number
  }
  readonly index_status: CodeIndexStatus | 'disabled'
  readonly index_revision: number
  readonly anchors_returned: number
  readonly failure: string | null
}

export interface HeadlessCodeGraphController {
  readonly queryPort: CodeContextQueryPort
  getDiagnostics(): HeadlessCodeGraphDiagnostics
  close(): Promise<void>
}

export interface HeadlessCodeGraphOptions {
  readonly workspaceRoot: string
  readonly logsDir: string
  readonly runtimeRoot: string
  readonly abortSignal?: AbortSignal
}

/** Headless 只装配共享 Runtime，不创建 watcher，也不在当前线程解析源码。 */
export async function startHeadlessCodeGraph(
  options: HeadlessCodeGraphOptions
): Promise<HeadlessCodeGraphController> {
  // 默认关闭时不会进入该动态 import，避免加载 SQLite、Tree-sitter 或 Worker 代码。
  const codeGraph = await import('../runtime/code-graph')
  const telemetry = new HeadlessCodeGraphTelemetry()
  let assembly: ReturnType<typeof codeGraph.createCodeGraphRuntimeAssembly>
  try {
    assembly = codeGraph.createCodeGraphRuntimeAssembly({
      workspaceRoot: options.workspaceRoot,
      appDataPath: options.logsDir,
      workerPath: join(options.runtimeRoot, 'codeGraphWorker.cjs'),
      grammarRoot: join(options.runtimeRoot, 'code-graph', 'grammars')
    })
  } catch (error) {
    telemetry.fail(error)
    return unavailableController(codeGraph, telemetry)
  }

  const unsubscribe = assembly.coordinator.subscribe((snapshot) => telemetry.observe(snapshot))
  const cancelStartup = () => {
    void assembly.coordinator.cancelCurrentOperation()
  }
  options.abortSignal?.addEventListener('abort', cancelStartup, { once: true })
  try {
    const snapshot = await assembly.coordinator.openWorkspace(
      assembly.workspace,
      assembly.readerProvider
    )
    if (!options.abortSignal?.aborted) {
      const startup = snapshot.activeGeneration === null
        ? assembly.coordinator.rebuild()
        : assembly.coordinator.checkDrift()
      if (options.abortSignal?.aborted) {
        await assembly.coordinator.cancelCurrentOperation()
      }
      await startup
    }
  } catch (error) {
    telemetry.fail(error)
  } finally {
    options.abortSignal?.removeEventListener('abort', cancelStartup)
  }

  return {
    queryPort: telemetry.wrap(assembly.queryPort),
    getDiagnostics: () => telemetry.snapshot(),
    close: async () => {
      unsubscribe()
      await assembly.coordinator.closeWorkspace(assembly.workspace.workspaceIdentity)
      await assembly.readerProvider.close()
    }
  }
}

export class HeadlessCodeGraphTelemetry {
  private status: CodeIndexStatus = 'idle'
  private revision = 0
  private callCount = 0
  private queryLatencyTotalMs = 0
  private queryLatencyMaxMs = 0
  private readonly queryLatenciesMs: number[] = []
  private anchorsReturned = 0
  private failureMessage: string | null = null

  observe(snapshot: CodeIndexSnapshot): void {
    this.status = snapshot.status
    this.revision = snapshot.revision
    this.failureMessage = snapshot.failure?.message ?? null
  }

  fail(error: unknown): void {
    this.status = 'unavailable'
    this.failureMessage = error instanceof Error ? error.message : String(error)
  }

  wrap(port: CodeContextQueryPort): CodeContextQueryPort {
    return Object.freeze({
      query: async (request: CodeContextQueryRequest): Promise<CodeContextPack> => {
        const startedAt = performance.now()
        this.callCount += 1
        try {
          const pack = await port.query(request)
          this.anchorsReturned += pack.anchors.length
          return pack
        } finally {
          const duration = performance.now() - startedAt
          this.queryLatencyTotalMs += duration
          this.queryLatencyMaxMs = Math.max(this.queryLatencyMaxMs, duration)
          this.queryLatenciesMs.push(duration)
        }
      }
    })
  }

  snapshot(): HeadlessCodeGraphDiagnostics {
    return Object.freeze({
      enabled: true,
      call_count: this.callCount,
      query_latency_ms: Object.freeze({
        total: roundMilliseconds(this.queryLatencyTotalMs),
        max: roundMilliseconds(this.queryLatencyMaxMs),
        average: roundMilliseconds(
          this.callCount === 0 ? 0 : this.queryLatencyTotalMs / this.callCount
        ),
        p50: roundMilliseconds(percentile(this.queryLatenciesMs, 0.5)),
        p95: roundMilliseconds(percentile(this.queryLatenciesMs, 0.95))
      }),
      index_status: this.status,
      index_revision: this.revision,
      anchors_returned: this.anchorsReturned,
      failure: this.failureMessage
    })
  }
}

function unavailableController(
  codeGraph: typeof import('../runtime/code-graph'),
  telemetry: HeadlessCodeGraphTelemetry
): HeadlessCodeGraphController {
  const port: CodeContextQueryPort = Object.freeze({
    query: async (request: CodeContextQueryRequest) => codeGraph.createEmptyCodeContextPack({
      status: 'unavailable',
      revision: 0,
      intent: request.intent ?? 'locate',
      summary: 'unavailable · 代码索引初始化失败；请改用 grep/read',
      warnings: ['代码索引初始化失败；请改用 grep/read']
    })
  })
  return {
    queryPort: telemetry.wrap(port),
    getDiagnostics: () => telemetry.snapshot(),
    close: async () => undefined
  }
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index] ?? 0
}

export function disabledHeadlessCodeGraphDiagnostics(): HeadlessCodeGraphDiagnostics {
  return Object.freeze({
    enabled: false,
    call_count: 0,
    query_latency_ms: Object.freeze({ total: 0, max: 0, average: 0, p50: 0, p95: 0 }),
    index_status: 'disabled',
    index_revision: 0,
    anchors_returned: 0,
    failure: null
  })
}
