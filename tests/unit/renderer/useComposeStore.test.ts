/**
 * useComposeStore — 会话门控、run 切换重置、终态清 askUser、interrupted 判定
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  useComposeStore,
  resetComposeStoreForTests
} from '../../../src/renderer/features/compose/useComposeStore'

const mockInvoke = vi.fn()

global.window = {
  ...global.window,
  api: {
    invoke: mockInvoke,
    on: vi.fn(() => () => {}),
    removeAllListeners: vi.fn()
  }
} as unknown as Window & typeof globalThis

function makeState(overrides: {
  id?: string
  status?: string
  session_id?: string
  phaseLabel?: string
} = {}): Record<string, unknown> {
  return {
    run: {
      id: overrides.id ?? 'run-1',
      command: 'br-full-dev',
      script: 'br-full-dev',
      started_at: '2026-07-09T00:00:00.000Z',
      updated_at: '2026-07-09T00:00:00.000Z',
      status: overrides.status ?? 'running',
      ...(overrides.session_id !== undefined
        ? { session_id: overrides.session_id }
        : {})
    },
    phase: {
      current: 'plan',
      label: overrides.phaseLabel ?? '阶段 2：计划',
      entered_at: '2026-07-09T00:00:00.000Z'
    },
    tasks: [],
    stats: { total: 0, done: 0, skipped: 0, failed: 0 }
  }
}

describe('useComposeStore', () => {
  beforeEach(() => {
    resetComposeStoreForTests()
    mockInvoke.mockReset()
  })

  it('applyState 写入 sessionId，供会话门控', () => {
    useComposeStore.getState().applyState('run-1', makeState(), 'sess-a')
    const s = useComposeStore.getState()
    expect(s.sessionId).toBe('sess-a')
    expect(s.runId).toBe('run-1')
    expect(s.state?.run.status).toBe('running')
  })

  it('runId 切换时重置 logs 与 pendingAskUser', () => {
    useComposeStore.getState().applyState('run-1', makeState({ id: 'run-1' }), 'sess-a')
    useComposeStore.getState().appendLog('run-1', '旧日志', 'sess-a')
    useComposeStore.getState().handleAskUser(
      {
        runId: 'run-1',
        requestId: 'req-1',
        question: '确认？',
        options: ['是', '否']
      },
      'sess-a'
    )
    expect(useComposeStore.getState().logs).toEqual(['旧日志'])
    expect(useComposeStore.getState().pendingAskUser).not.toBeNull()

    useComposeStore
      .getState()
      .applyState('run-2', makeState({ id: 'run-2' }), 'sess-a')
    const s = useComposeStore.getState()
    expect(s.runId).toBe('run-2')
    expect(s.logs).toEqual([])
    expect(s.pendingAskUser).toBeNull()
  })

  it('终态 applyState 清除 pendingAskUser', () => {
    useComposeStore.getState().applyState('run-1', makeState(), 'sess-a')
    useComposeStore.getState().handleAskUser(
      {
        runId: 'run-1',
        requestId: 'req-1',
        question: '发布？',
        options: ['发布', '取消']
      },
      'sess-a'
    )
    expect(useComposeStore.getState().pendingAskUser).not.toBeNull()

    useComposeStore
      .getState()
      .applyState('run-1', makeState({ status: 'completed' }), 'sess-a')
    expect(useComposeStore.getState().pendingAskUser).toBeNull()
    expect(useComposeStore.getState().state?.run.status).toBe('completed')
  })

  it('loadStateFromDisk：session_id 不匹配则清空不显示', async () => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'compose:get-state') {
        return makeState({ session_id: 'other-sess' })
      }
      return null
    })
    await useComposeStore.getState().loadStateFromDisk('/ws', 'sess-a')
    const s = useComposeStore.getState()
    expect(s.state).toBeNull()
    expect(s.sessionId).toBeNull()
    expect(s.runId).toBeNull()
  })

  it('loadStateFromDisk：running 但 compose:status 查无 → viewStatus interrupted', async () => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'compose:get-state') {
        return makeState({ session_id: 'sess-a', status: 'running' })
      }
      if (channel === 'compose:status') {
        return null
      }
      return null
    })
    await useComposeStore.getState().loadStateFromDisk('/ws', 'sess-a')
    const s = useComposeStore.getState()
    expect(s.sessionId).toBe('sess-a')
    expect(s.state?.run.status).toBe('running')
    expect(s.viewStatus).toBe('interrupted')
  })

  it('loadStateFromDisk：running 且仍在 activeRuns → 不标 interrupted', async () => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'compose:get-state') {
        return makeState({ session_id: 'sess-a', status: 'running' })
      }
      if (channel === 'compose:status') {
        return { runId: 'run-1', status: 'running', phase: 'plan' }
      }
      return null
    })
    await useComposeStore.getState().loadStateFromDisk('/ws', 'sess-a')
    expect(useComposeStore.getState().viewStatus).toBeNull()
    expect(useComposeStore.getState().state?.run.status).toBe('running')
  })

  it('dismiss 清空全部 UI 状态', () => {
    useComposeStore.getState().applyState('run-1', makeState(), 'sess-a')
    useComposeStore.getState().appendLog('run-1', 'log', 'sess-a')
    useComposeStore.getState().dismiss()
    const s = useComposeStore.getState()
    expect(s.runId).toBeNull()
    expect(s.sessionId).toBeNull()
    expect(s.state).toBeNull()
    expect(s.logs).toEqual([])
    expect(s.pendingAskUser).toBeNull()
    expect(s.viewStatus).toBeNull()
  })
})
