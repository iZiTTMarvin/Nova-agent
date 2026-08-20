import { describe, expect, it, vi } from 'vitest'
import {
  CodeGraphEngine,
  type CodeContextPack
} from '@runtime/code-graph/context'
import { EMPTY_CODE_INDEX_COVERAGE } from '@runtime/code-graph/types'
import type {
  CodeGraphQueryEvidence,
  CodeGraphReader
} from '@runtime/code-graph/graph/queries/CodeGraphReader'
import type { CodeIndexSnapshot } from '@runtime/code-graph/types'

function snapshot(
  status: CodeIndexSnapshot['status'],
  activeGeneration: number | null
): CodeIndexSnapshot {
  return Object.freeze({
    workspaceIdentity: 'workspace-1',
    activeGeneration,
    revision: activeGeneration === null ? 0 : 4,
    status,
    coverage: Object.freeze({
      ...EMPTY_CODE_INDEX_COVERAGE,
      eligibleFiles: 1,
      indexedFiles: activeGeneration === null ? 0 : 1
    }),
    progress: status === 'building' ? Object.freeze({ completed: 0, total: 1 }) : null,
    lastCompletedAt: activeGeneration === null ? null : 4,
    failure: null,
    workerState: status === 'building' ? 'running' : 'stopped'
  })
}

function evidence(): CodeGraphQueryEvidence {
  return Object.freeze({
    snapshot: Object.freeze({
      activeGeneration: 1,
      revision: 4,
      coverage: Object.freeze({
        ...EMPTY_CODE_INDEX_COVERAGE,
        eligibleFiles: 1,
        indexedFiles: 1
      })
    }),
    anchors: Object.freeze([{
      symbolId: 1,
      fileId: 1,
      stableId: 'symbol:auth',
      name: 'verifyToken',
      qualifiedName: 'verifyToken',
      kind: 'function',
      path: 'auth.ts',
      startLine: 1,
      endLine: 3,
      fileLineCount: 3,
      identifierTokens: 'verify token verifytoken',
      exactName: true,
      exactQualifiedName: true,
      exactPath: false,
      ftsRank: -1
    }]),
    relations: Object.freeze([]),
    unresolved: Object.freeze([])
  })
}

describe('CodeGraphEngine', () => {
  it('首次构建时只返回可恢复状态，不打开读取端', async () => {
    const getReader = vi.fn<() => Promise<CodeGraphReader | null>>()
    const engine = new CodeGraphEngine({
      getSnapshot: () => snapshot('building', null),
      getReader
    })

    const pack = await engine.query({ query: 'verifyToken' })

    expect(pack.status).toBe('building')
    expect(pack.coverage.eligibleFiles).toBe(1)
    expect(pack.warnings.join(' ')).toContain('grep/read')
    expect(getReader).not.toHaveBeenCalled()
  })

  it('flow 不受索引建设状态影响，始终显式不可用', async () => {
    const engine = new CodeGraphEngine({
      getSnapshot: () => snapshot('building', null),
      getReader: async () => null
    })

    const pack = await engine.query({ query: 'request flow', intent: 'flow' })

    expect(pack.status).toBe('unavailable')
    expect(pack.intent).toBe('flow')
    expect(pack.summary).toContain('当前版本不提供多跳代码流')
  })

  it('从已提交 revision 生成真实 Context Pack', async () => {
    const reader: CodeGraphReader = {
      readEvidence: async () => evidence(),
      close: async () => undefined
    }
    const engine = new CodeGraphEngine({
      getSnapshot: () => snapshot('ready', 1),
      getReader: async () => reader
    })

    const pack: CodeContextPack = await engine.query({
      query: 'verifyToken',
      intent: 'locate'
    })

    expect(pack.status).toBe('ready')
    expect(pack.revision).toBe(4)
    expect(pack.anchors.map((anchor) => anchor.path)).toEqual(['auth.ts'])
  })

  it('读取端不可用时仍保留最近一次已提交快照信息', async () => {
    const engine = new CodeGraphEngine({
      getSnapshot: () => snapshot('degraded', 1),
      getReader: async () => null
    })

    const pack = await engine.query({ query: 'verifyToken' })

    expect(pack.status).toBe('unavailable')
    expect(pack.revision).toBe(4)
    expect(pack.coverage).toMatchObject({ eligibleFiles: 1, indexedFiles: 1 })
  })

  it('查询期间的 AbortSignal 在证据返回后仍会终止结果构建', async () => {
    const controller = new AbortController()
    const reader: CodeGraphReader = {
      readEvidence: async () => {
        controller.abort()
        return evidence()
      },
      close: async () => undefined
    }
    const engine = new CodeGraphEngine({
      getSnapshot: () => snapshot('ready', 1),
      getReader: async () => reader
    })

    await expect(engine.query({
      query: 'verifyToken',
      abortSignal: controller.signal
    })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
