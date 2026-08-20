// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeIndexStatusDto } from '../../../src/shared/code-index'
import {
  resetCodeIndexStoreForTests,
  selectCurrentCodeIndexStatus,
  useCodeIndexStore
} from '../../../src/renderer/stores/useCodeIndexStore'

const invoke = vi.fn()

describe('useCodeIndexStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetCodeIndexStoreForTests()
    Object.assign(window, {
      api: {
        invoke,
        on: vi.fn(),
        removeAllListeners: vi.fn()
      }
    })
  })

  it('snapshot-first 前忽略事件，拉取后丢弃过期 sequence', async () => {
    useCodeIndexStore.setState({ currentWorkspaceRoot: 'C:\\repo-a' })
    useCodeIndexStore.getState().handleStatusEvent(status('C:\\repo-a', 2, 'building'))
    expect(selectCurrentCodeIndexStatus(useCodeIndexStore.getState())).toBeNull()

    invoke.mockResolvedValue(status('C:\\repo-a', 3, 'building'))
    await useCodeIndexStore.getState().refreshStatus()
    useCodeIndexStore.getState().handleStatusEvent(status('C:\\repo-a', 2, 'ready'))
    expect(selectCurrentCodeIndexStatus(useCodeIndexStore.getState())?.status).toBe('building')

    useCodeIndexStore.getState().handleStatusEvent(status('C:\\repo-a', 4, 'ready'))
    expect(selectCurrentCodeIndexStatus(useCodeIndexStore.getState())?.status).toBe('ready')
  })

  it('按 workspaceRoot 分桶，旧工作区迟到事件不污染当前显示', async () => {
    useCodeIndexStore.setState({ currentWorkspaceRoot: 'C:\\repo-a' })
    invoke.mockResolvedValueOnce(status('C:\\repo-a', 1, 'ready'))
    await useCodeIndexStore.getState().refreshStatus()

    useCodeIndexStore.setState({ currentWorkspaceRoot: 'C:\\repo-b' })
    invoke.mockResolvedValueOnce(status('C:\\repo-b', 1, 'building'))
    await useCodeIndexStore.getState().refreshStatus()
    useCodeIndexStore.getState().handleStatusEvent(status('C:\\repo-a', 2, 'degraded'))

    const current = selectCurrentCodeIndexStatus(useCodeIndexStore.getState())
    expect(current?.workspaceRoot).toBe('C:\\repo-b')
    expect(current?.status).toBe('building')
  })

  it('当前会话关闭能力后忽略同工作区 Runtime 的后续事件', async () => {
    useCodeIndexStore.setState({ currentWorkspaceRoot: 'C:\\repo' })
    invoke.mockResolvedValue(status('C:\\repo', 5, 'idle', false))
    useCodeIndexStore.getState().syncWorkspace('C:\\repo', { resetForSessionChange: true })
    await Promise.resolve()
    useCodeIndexStore.getState().handleStatusEvent(status('C:\\repo', 6, 'ready'))

    const current = selectCurrentCodeIndexStatus(useCodeIndexStore.getState())
    expect(current?.enabled).toBe(false)
    expect(current?.sequence).toBe(5)
  })

  it('同工作区并发拉取乱序返回时只接受最后一次结果', async () => {
    let resolveFirst: ((value: CodeIndexStatusDto) => void) | null = null
    let resolveSecond: ((value: CodeIndexStatusDto) => void) | null = null
    invoke
      .mockImplementationOnce(() => new Promise<CodeIndexStatusDto>((resolve) => {
        resolveFirst = resolve
      }))
      .mockImplementationOnce(() => new Promise<CodeIndexStatusDto>((resolve) => {
        resolveSecond = resolve
      }))

    useCodeIndexStore.setState({ currentWorkspaceRoot: 'C:\\repo' })
    const first = useCodeIndexStore.getState().refreshStatus()
    const second = useCodeIndexStore.getState().refreshStatus()

    resolveSecond?.(status('C:\\repo', 7, 'ready'))
    await second
    resolveFirst?.(status('C:\\repo', 8, 'building'))
    await first

    const current = selectCurrentCodeIndexStatus(useCodeIndexStore.getState())
    expect(current?.status).toBe('ready')
    expect(current?.sequence).toBe(7)
  })
})

function status(
  workspaceRoot: string,
  sequence: number,
  state: CodeIndexStatusDto['status'],
  enabled = true
): CodeIndexStatusDto {
  return {
    workspaceRoot,
    sequence,
    enabled,
    status: state,
    activeGeneration: state === 'ready' ? 1 : null,
    revision: state === 'ready' ? 1 : 0,
    coverage: {
      eligibleFiles: 10,
      indexedFiles: state === 'ready' ? 10 : 2,
      parseFailures: 0,
      unsupportedFiles: 0,
      oversizedFiles: 0,
      unresolvedRelations: 0
    },
    progress: state === 'building' ? { completed: 2, total: 10 } : null,
    lastCompletedAt: state === 'ready' ? 1 : null,
    failure: null,
    workerState: state === 'building' ? 'running' : 'idle',
    databaseBytes: 0
  }
}
