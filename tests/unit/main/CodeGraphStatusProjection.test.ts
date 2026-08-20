import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODE_INDEX_STATUS_THROTTLE_MS,
  CodeGraphStatusProjection
} from '../../../src/main/services/CodeGraphStatusProjection'
import type { CodeIndexSnapshot } from '../../../src/runtime/code-graph'

describe('CodeGraphStatusProjection', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('在固定窗口内只广播最终快照，并为每个工作区维护单调序号', async () => {
    vi.useFakeTimers()
    const projection = new CodeGraphStatusProjection({
      readDatabaseBytes: async () => 4096
    })
    const broadcasts: Array<{ workspaceRoot: string | null; sequence: number; status: string }> = []
    projection.setBroadcaster(snapshot => {
      broadcasts.push({
        workspaceRoot: snapshot.workspaceRoot,
        sequence: snapshot.sequence,
        status: snapshot.status
      })
    })

    projection.observe('C:\\repo-a', snapshot('updating', 2), 'a.db')
    projection.observe('C:\\repo-a', snapshot('ready', 3), 'a.db')
    await vi.advanceTimersByTimeAsync(CODE_INDEX_STATUS_THROTTLE_MS - 1)
    expect(broadcasts).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(broadcasts).toEqual([
      { workspaceRoot: 'C:\\repo-a', sequence: 1, status: 'ready' }
    ])

    const pulled = await projection.getEnabledStatus(
      'C:\\repo-a',
      snapshot('ready', 3),
      'a.db'
    )
    const other = await projection.getEnabledStatus(
      'C:\\repo-b',
      snapshot('building', 0),
      'b.db'
    )
    expect(pulled.sequence).toBe(2)
    expect(other.sequence).toBe(1)
    expect(pulled.databaseBytes).toBe(4096)
  })

  it('暂停工作区时取消尚未广播的状态', async () => {
    vi.useFakeTimers()
    const projection = new CodeGraphStatusProjection({ readDatabaseBytes: async () => 0 })
    const broadcaster = vi.fn()
    projection.setBroadcaster(broadcaster)
    projection.observe('C:\\repo', snapshot('building', 0), 'index.db')
    projection.suspend('C:\\repo')

    await vi.advanceTimersByTimeAsync(CODE_INDEX_STATUS_THROTTLE_MS)
    expect(broadcaster).not.toHaveBeenCalled()
  })

  it('异步读取数据库大小期间出现新快照时不广播旧状态', async () => {
    vi.useFakeTimers()
    let releaseFirstRead: (() => void) | null = null
    let reads = 0
    const projection = new CodeGraphStatusProjection({
      readDatabaseBytes: async () => {
        reads += 1
        if (reads === 1) {
          await new Promise<void>(resolve => {
            releaseFirstRead = resolve
          })
        }
        return 1
      }
    })
    const broadcaster = vi.fn()
    projection.setBroadcaster(broadcaster)

    projection.observe('C:\\repo', snapshot('updating', 1), 'index.db')
    await vi.advanceTimersByTimeAsync(CODE_INDEX_STATUS_THROTTLE_MS)
    projection.observe('C:\\repo', snapshot('ready', 2), 'index.db')
    releaseFirstRead?.()
    await Promise.resolve()
    expect(broadcaster).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(CODE_INDEX_STATUS_THROTTLE_MS)
    expect(broadcaster).toHaveBeenCalledTimes(1)
    expect(broadcaster.mock.calls[0][0].status).toBe('ready')
  })
})

function snapshot(status: CodeIndexSnapshot['status'], revision: number): CodeIndexSnapshot {
  return {
    workspaceIdentity: 'workspace-a',
    activeGeneration: revision === 0 ? null : 1,
    revision,
    status,
    coverage: {
      eligibleFiles: 10,
      indexedFiles: revision === 0 ? 0 : 10,
      parseFailures: 0,
      unsupportedFiles: 0,
      oversizedFiles: 0,
      unresolvedRelations: 0
    },
    progress: status === 'building' ? { completed: 2, total: 10 } : null,
    lastCompletedAt: status === 'ready' ? 100 : null,
    failure: null,
    workerState: status === 'building' ? 'running' : 'idle'
  }
}
