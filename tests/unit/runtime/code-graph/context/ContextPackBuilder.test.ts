import { describe, expect, it } from 'vitest'
import type {
  CodeGraphAnchorCandidate,
  CodeGraphQueryEvidence,
  CodeGraphReader,
  CodeGraphRelationCandidate,
  CodeGraphUnresolvedCandidate
} from '@runtime/code-graph/graph/queries/CodeGraphReader'
import {
  CODE_CONTEXT_LIMITS,
  ContextPackBuilder
} from '@runtime/code-graph'
import type { CodeContextBuildRequest } from '@runtime/code-graph'

describe('ContextPackBuilder', () => {
  it('输出摘要键前置的单行稳定 JSON，并在目标预算内保留证据警告', async () => {
    const evidence = largeEvidence()
    const builder = new ContextPackBuilder({ reader: fixedReader(evidence) })
    const request: CodeContextBuildRequest = {
      query: 'Service',
      intent: 'impact',
      status: 'updating'
    }

    const first = await builder.build(request)
    const second = await builder.build(request)
    const parsed: unknown = JSON.parse(first)

    expect(second).toBe(first)
    expect(first.startsWith('{"status":"updating","revision":42,"summary":')).toBe(true)
    expect(first.slice(0, 200)).toContain('updating · impact')
    expect(first).not.toContain('\n')
    expect(Buffer.byteLength(first, 'utf8')).toBeLessThanOrEqual(
      CODE_CONTEXT_LIMITS.targetBytes
    )
    expect(parsed).toMatchObject({
      status: 'updating',
      revision: 42,
      intent: 'impact'
    })
    if (!isPackShape(parsed)) throw new Error('Context Pack 结构无效')
    expect(parsed.anchors.length).toBeLessThanOrEqual(CODE_CONTEXT_LIMITS.anchors)
    expect(parsed.relations.length).toBeLessThanOrEqual(CODE_CONTEXT_LIMITS.relations)
    expect(parsed.recommendedReads.length).toBeLessThanOrEqual(
      CODE_CONTEXT_LIMITS.recommendedReads
    )
    expect(parsed.summary).toContain(
      `返回 ${parsed.relations.length} 条直接关系、0 条二跳候选`
    )
    expect(parsed.warnings.join(' ')).toContain('最近一次已提交 revision')
    expect(parsed.warnings.join(' ')).toContain('不能据此判断无影响')
    expect(first).not.toMatch(/风险低|low risk|"safe"/i)
    expect(first).not.toContain('SECRET_SOURCE_BODY')
  })

  it('flow 返回结构化不可用结果，不静默改成其他 intent', async () => {
    const builder = new ContextPackBuilder({ reader: fixedReader(largeEvidence()) })
    const text = await builder.build({
      query: 'Service',
      intent: 'flow',
      status: 'ready'
    })
    const parsed: unknown = JSON.parse(text)
    if (!isPackShape(parsed)) throw new Error('Context Pack 结构无效')

    expect(parsed.status).toBe('unavailable')
    expect(parsed.intent).toBe('flow')
    expect(parsed.relations).toEqual([])
    expect(parsed.warnings.join(' ')).toContain('flow 当前不可用')
  })

  it('首次构建无 last-good 时返回可恢复状态并支持取消', async () => {
    const controller = new AbortController()
    const builder = new ContextPackBuilder({
      reader: fixedReader({
        snapshot: {
          activeGeneration: null,
          revision: 0,
          coverage: emptyCoverage()
        },
        anchors: [],
        relations: [],
        unresolved: []
      })
    })
    const text = await builder.build({ query: 'Service', status: 'building' })
    const parsed: unknown = JSON.parse(text)
    if (!isPackShape(parsed)) throw new Error('Context Pack 结构无效')
    expect(parsed.summary).toContain('未找到已索引锚点')
    expect(parsed.warnings.join(' ')).toContain('grep/read')

    controller.abort()
    await expect(builder.build({
      query: 'Service',
      status: 'building',
      abortSignal: controller.signal
    })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

function fixedReader(evidence: CodeGraphQueryEvidence): CodeGraphReader {
  return {
    readEvidence: async () => evidence,
    close: async () => undefined
  }
}

function largeEvidence(): CodeGraphQueryEvidence {
  const anchors = Array.from({ length: 12 }, (_, index) => candidate(index))
  const relations = Array.from({ length: 30 }, (_, index) => relation(index))
  const unresolved: CodeGraphUnresolvedCandidate[] = [{
    stableId: 'unresolved:1',
    fileId: 1,
    sourceSymbolStableId: 'symbol:0',
    filePath: 'src/service-0.ts',
    kind: 'calls',
    rawTarget: 'client.dynamic SECRET_SOURCE_BODY',
    moduleSpecifier: null,
    sourceLine: 80,
    reason: 'dynamic_dispatch',
    resolver: 'structural'
  }]
  return {
    snapshot: {
      activeGeneration: 3,
      revision: 42,
      coverage: {
        eligibleFiles: 100,
        indexedFiles: 96,
        parseFailures: 1,
        unsupportedFiles: 2,
        oversizedFiles: 1,
        unresolvedRelations: 9
      }
    },
    anchors,
    relations,
    unresolved
  }
}

function candidate(index: number): CodeGraphAnchorCandidate {
  return {
    symbolId: index + 1,
    fileId: index + 1,
    stableId: `symbol:${index}`,
    name: index === 0 ? 'Service' : `Service${index}`,
    qualifiedName: index === 0 ? 'Service' : `Feature.Service${index}`,
    kind: 'class',
    path: `src/${'nested/'.repeat(8)}service-${index}.ts`,
    startLine: 40 + index,
    endLine: 120 + index,
    fileLineCount: 400,
    identifierTokens: `service service${index}`,
    exactName: index === 0,
    exactQualifiedName: false,
    exactPath: false,
    ftsRank: index
  }
}

function relation(index: number): CodeGraphRelationCandidate {
  return {
    stableId: `edge:${index}`,
    graphKind: 'symbol',
    type: index % 2 === 0 ? 'calls' : 'references',
    from: `Caller${index}${'Long'.repeat(20)}`,
    to: 'Service',
    sourceSymbolStableId: `caller:${index}`,
    targetSymbolStableId: 'symbol:0',
    sourceSymbolId: index + 20,
    targetSymbolId: 1,
    sourceFileId: index + 20,
    targetFileId: 1,
    confidence: index % 3 === 0 ? 'confirmed' : 'probable',
    resolver: index % 3 === 0 ? 'structural' : 'relative-path',
    sourceFile: `src/callers/${'nested/'.repeat(8)}caller-${index}.ts`,
    sourceLine: 10 + index,
    sourceFileLineCount: 400
  }
}

function emptyCoverage() {
  return {
    eligibleFiles: 0,
    indexedFiles: 0,
    parseFailures: 0,
    unsupportedFiles: 0,
    oversizedFiles: 0,
    unresolvedRelations: 0
  }
}

function isPackShape(value: unknown): value is {
  status: string
  intent: string
  summary: string
  anchors: unknown[]
  relations: unknown[]
  recommendedReads: unknown[]
  warnings: string[]
} {
  if (!isRecord(value)) return false
  const record = value
  return typeof record.status === 'string' &&
    typeof record.intent === 'string' &&
    typeof record.summary === 'string' &&
    Array.isArray(record.anchors) &&
    Array.isArray(record.relations) &&
    Array.isArray(record.recommendedReads) &&
    Array.isArray(record.warnings) &&
    record.warnings.every((warning) => typeof warning === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
