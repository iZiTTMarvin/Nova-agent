import { describe, expect, it } from 'vitest'
import {
  disabledHeadlessCodeGraphDiagnostics,
  HeadlessCodeGraphTelemetry
} from '../../../src/headless/codeGraph'
import {
  EMPTY_CODE_INDEX_COVERAGE,
  type CodeContextPack,
  type CodeIndexSnapshot
} from '../../../src/runtime/code-graph'

const READY_SNAPSHOT: CodeIndexSnapshot = Object.freeze({
  workspaceIdentity: 'workspace',
  status: 'ready',
  activeGeneration: 1,
  revision: 3,
  progress: null,
  coverage: EMPTY_CODE_INDEX_COVERAGE,
  failure: null,
  workerState: 'idle'
})

const PACK: CodeContextPack = Object.freeze({
  status: 'ready',
  revision: 3,
  summary: 'ready · locate · found',
  intent: 'locate',
  anchors: Object.freeze([
    Object.freeze({
      kind: 'function',
      name: 'found',
      path: 'src/index.ts',
      startLine: 1,
      endLine: 1,
      score: 1
    })
  ]),
  relations: Object.freeze([]),
  recommendedReads: Object.freeze([]),
  coverage: EMPTY_CODE_INDEX_COVERAGE,
  warnings: Object.freeze([])
})

describe('headless code graph diagnostics', () => {
  it('关闭时保持零调用、零索引状态', () => {
    expect(disabledHeadlessCodeGraphDiagnostics()).toEqual({
      enabled: false,
      call_count: 0,
      query_latency_ms: { total: 0, max: 0, average: 0, p50: 0, p95: 0 },
      index_status: 'disabled',
      index_revision: 0,
      anchors_returned: 0,
      failure: null
    })
  })

  it('只观察 Coordinator 快照并统计真实查询结果', async () => {
    const telemetry = new HeadlessCodeGraphTelemetry()
    telemetry.observe(READY_SNAPSHOT)
    const port = telemetry.wrap({ query: async () => PACK })

    await port.query({ query: 'found', intent: 'locate' })
    await port.query({ query: 'found', intent: 'understand' })

    const diagnostics = telemetry.snapshot()
    expect(diagnostics.enabled).toBe(true)
    expect(diagnostics.index_status).toBe('ready')
    expect(diagnostics.index_revision).toBe(3)
    expect(diagnostics.call_count).toBe(2)
    expect(diagnostics.anchors_returned).toBe(2)
    expect(diagnostics.query_latency_ms.total).toBeGreaterThanOrEqual(0)
    expect(diagnostics.query_latency_ms.max).toBeGreaterThanOrEqual(0)
    expect(diagnostics.query_latency_ms.p50).toBeGreaterThanOrEqual(0)
    expect(diagnostics.query_latency_ms.p95).toBeGreaterThanOrEqual(
      diagnostics.query_latency_ms.p50
    )
  })
})
