import type { RunSnapshot } from '../../../src/shared/run/types'
import { useRunStore } from '../../../src/renderer/stores/useRunStore'

export function makeRunSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: 'run_1',
    sessionId: 'sess_1',
    messageId: 'msg_1',
    workspaceId: '/test/project',
    kind: 'agent',
    status: 'running',
    sequence: 1,
    pendingInteractions: [],
    currentAttempt: null,
    progress: null,
    lastHeartbeatAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

export function publishRunSnapshot(snapshot: RunSnapshot): void {
  useRunStore.getState().handleSnapshotEvent(snapshot, {
    sequence: snapshot.sequence,
    type: 'snapshot',
    at: snapshot.updatedAt
  })
}
