import { describe, expect, it } from 'vitest'
import {
  parseCodeIndexHostMessage,
  parseCodeIndexWorkerMessage
} from '@runtime/code-graph/worker/protocol'

describe('Code Index Worker protocol', () => {
  it('校验增量 change batch 并拒绝越界路径', () => {
    const request = incrementalMessage([{ type: 'change', path: 'src/a.ts' }])
    expect(parseCodeIndexHostMessage(request)).toMatchObject({
      kind: 'run',
      request: {
        operation: { kind: 'incremental-update' },
        changeBatch: [{ type: 'change', path: 'src/a.ts' }]
      }
    })
    expect(parseCodeIndexHostMessage(incrementalMessage([
      { type: 'unlink', path: '../outside.ts' }
    ]))).toBeNull()
  })

  it('drift 使用 null batch，rebuild-required 结果保留原 revision', () => {
    const parsed = parseCodeIndexHostMessage(incrementalMessage(null))
    expect(parsed).toMatchObject({ request: { changeBatch: null } })
    expect(parseCodeIndexWorkerMessage({
      kind: 'result',
      requestId: 1,
      result: {
        operation: operation(),
        outcome: 'rebuild-required',
        rebuildReason: 'bulk-change',
        metadata: metadata(),
        coverage: coverage(),
        durationMs: 10
      }
    })).toMatchObject({
      result: {
        outcome: 'rebuild-required',
        rebuildReason: 'bulk-change',
        metadata: { revision: 4 }
      }
    })
  })

  it('访问时间请求只接受 Host 采样的非负时间', () => {
    const message = incrementalMessage(undefined)
    message.request.operation.kind = 'touch-access'
    delete message.request.changeBatch
    message.request.accessedAt = 123
    expect(parseCodeIndexHostMessage(message)).toMatchObject({
      request: { operation: { kind: 'touch-access' }, accessedAt: 123 }
    })

    message.request.accessedAt = -1
    expect(parseCodeIndexHostMessage(message)).toBeNull()
  })
})

function incrementalMessage(changeBatch: unknown) {
  return {
    kind: 'run',
    requestId: 1,
    request: {
      operation: operation(),
      workspace: {
        workspaceIdentity: 'workspace-a',
        workspaceRoot: 'C:\\workspace-a',
        dbPath: 'C:\\index.db',
        parserSignature: 'parser-v1',
        resolverSignature: 'resolver-v1',
        coreWasmPath: 'C:\\core.wasm',
        grammarWasmPaths: {
          javascript: 'C:\\javascript.wasm',
          typescript: 'C:\\typescript.wasm',
          tsx: 'C:\\tsx.wasm',
          python: 'C:\\python.wasm'
        }
      },
      changeBatch
    }
  }
}

function operation() {
  return {
    operationId: 'incremental-1',
    kind: 'incremental-update',
    workspaceIdentity: 'workspace-a',
    generation: 2,
    baseGeneration: 2,
    baseRevision: 4
  }
}

function metadata() {
  return {
    schemaVersion: 2,
    workspaceIdentity: 'workspace-a',
    activeGeneration: 2,
    revision: 4,
    parserSignature: 'parser-v1',
    resolverSignature: 'resolver-v1',
    lastCompletedAt: 100,
    lastAccessed: 200
  }
}

function coverage() {
  return {
    eligibleFiles: 10,
    indexedFiles: 10,
    parseFailures: 0,
    unsupportedFiles: 0,
    oversizedFiles: 0,
    unresolvedRelations: 0
  }
}
