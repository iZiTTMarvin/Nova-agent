/**
 * Renderer sequence 不得回退
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useRunStore, getRunInterruptionNotice } from '../../../src/renderer/stores/useRunStore'
import type { RunSnapshot } from '../../../src/shared/run/types'

function snap(partial: Partial<RunSnapshot> & Pick<RunSnapshot, 'runId' | 'sessionId' | 'sequence' | 'status'>): RunSnapshot {
  return {
    kind: 'agent',
    workspaceId: '/ws',
    messageId: 'm',
    pendingInteractions: [],
    currentAttempt: null,
    progress: null,
    lastHeartbeatAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...partial
  }
}

describe('useRunStore sequence 回退防护', () => {
  beforeEach(() => {
    useRunStore.setState({
      snapshot: null,
      lastSequence: 0,
      snapshotsByRunId: {},
      activeRunIdBySessionId: {},
      lastSequenceByRunId: {},
      selectedSessionId: 'sA',
      pullTokenByRunId: {}
    })
  })

  it('terminal seq=10 后迟到 running seq=9，状态不得回退', () => {
    const runId = 'runA'
    useRunStore.getState().handleSnapshotEvent(
      snap({ runId, sessionId: 'sA', sequence: 10, status: 'completed' }),
      { sequence: 10, type: 'terminal', at: 1 }
    )
    expect(useRunStore.getState().snapshotsByRunId[runId]?.status).toBe('completed')

    useRunStore.getState().handleSnapshotEvent(
      snap({ runId, sessionId: 'sA', sequence: 9, status: 'running' }),
      { sequence: 9, type: 'heartbeat', at: 2 }
    )
    expect(useRunStore.getState().snapshotsByRunId[runId]?.status).toBe('completed')
    expect(useRunStore.getState().lastSequenceByRunId[runId]).toBe(10)
  })

  it('相同事件重复广播幂等', () => {
    const runId = 'runB'
    const s = snap({ runId, sessionId: 'sA', sequence: 3, status: 'running' })
    useRunStore.getState().handleSnapshotEvent(s, { sequence: 3, type: 'x', at: 1 })
    useRunStore.getState().handleSnapshotEvent(s, { sequence: 3, type: 'x', at: 2 })
    expect(useRunStore.getState().lastSequenceByRunId[runId]).toBe(3)
  })

  it('新轮开始即移除旧中断提示；旧轮迟到终态不能覆盖新轮', () => {
    const old = snap({ runId: 'old', sessionId: 'sA', sequence: 10, status: 'interrupted', terminalReason: 'process_exit', createdAt: 1 })
    const current = snap({ runId: 'new', sessionId: 'sA', sequence: 1, status: 'running', createdAt: 2 })
    const store = useRunStore.getState()
    store.handleSnapshotEvent(old, { sequence: 10, type: 'terminal', at: 1 })
    expect(getRunInterruptionNotice(useRunStore.getState().snapshot)).toContain('任务意外中断')
    store.handleSnapshotEvent(current, { sequence: 1, type: 'running', at: 2 })
    expect(getRunInterruptionNotice(useRunStore.getState().snapshot)).toBeNull()
    store.handleSnapshotEvent({ ...old, sequence: 11 }, { sequence: 11, type: 'outbox', at: 3 })
    expect(useRunStore.getState().snapshot?.runId).toBe('new')
    expect(useRunStore.getState().activeRunIdBySessionId.sA).toBe('new')
    expect(getRunInterruptionNotice(useRunStore.getState().snapshot)).toBeNull()
    expect(useRunStore.getState().snapshotsByRunId.old.sequence).toBe(11)
  })

  it('run 创建时尚未绑定消息，后续消息身份和终态仍被接受', () => {
    const initial = snap({ runId: 'binding', sessionId: 'sA', sequence: 1, status: 'queued', messageId: '' })
    const bound = { ...initial, sequence: 3, status: 'running' as const, messageId: 'assistant-1' }
    const terminal = { ...bound, sequence: 9, status: 'completed' as const }
    for (const snapshot of [initial, bound, terminal]) {
      useRunStore.getState().handleSnapshotEvent(snapshot, { sequence: snapshot.sequence, type: 'snapshot', at: 1 })
    }
    expect(useRunStore.getState().snapshot).toEqual(terminal)
  })

  it('完整快照允许合帧跳号，直接接受最新状态而不补拉', () => {
    const invoke = vi.fn().mockResolvedValue({ snapshot: null, waitingSessions: [] })
    global.window = {
      ...global.window,
      api: {
        invoke,
        on: vi.fn(),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis

    const runId = 'runGap'
    useRunStore.getState().handleSnapshotEvent(
      snap({ runId, sessionId: 'sA', sequence: 2, status: 'running' }),
      { sequence: 2, type: 'heartbeat', at: 1 }
    )
    useRunStore.getState().handleSnapshotEvent(
      snap({ runId, sessionId: 'sA', sequence: 5, status: 'running' }),
      { sequence: 5, type: 'turn_draft_upsert', at: 2 }
    )
    expect(useRunStore.getState().lastSequenceByRunId[runId]).toBe(5)
    expect(useRunStore.getState().snapshot?.sequence).toBe(5)
    expect(invoke).not.toHaveBeenCalledWith('run:get-snapshot', { sessionId: 'sA' })
  })
})
