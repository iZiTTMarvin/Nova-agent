/**
 * Renderer sequence 不得回退
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useRunStore } from '../../../../src/renderer/stores/useRunStore'
import type { RunSnapshot } from '../../../../src/runtime/run/types'

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
      pullTokenByRunId: {},
      interruptedRunId: null
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
})
