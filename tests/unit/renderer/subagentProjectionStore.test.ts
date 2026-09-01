import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  selectLatestSubagentByChildSessionId,
  selectSubagentByParentToolCallId,
  useSubagentProjectionStore
} from '../../../src/renderer/features/subagents/projection'
import type { RunSnapshot } from '../../../src/shared/run/types'
import type { Session } from '../../../src/shared/session/types'
import type { SubagentActivityProjection } from '../../../src/shared/subagents'

const projection: SubagentActivityProjection = {
  childSessionId: 'sess-child',
  childRunId: 'run-child',
  parentSessionId: 'sess-parent',
  parentToolCallId: 'call-task',
  taskLabel: 'Inspect runtime',
  profile: {
    profileId: 'explore',
    name: 'Explore',
    permissionCeiling: 'read_only'
  },
  status: 'running',
  startedAt: 100,
  artifactCount: 0
}

const sessions: Session[] = [
  {
    id: 'sess-parent',
    kind: 'primary',
    workspaceRoot: 'D:/workspace',
    mode: 'default',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1
  },
  {
    id: 'sess-child',
    kind: 'subagent',
    workspaceRoot: 'D:/workspace',
    mode: 'default',
    createdAt: 2,
    updatedAt: 2,
    messageCount: 1,
    subagent: {
      lineage: {
        parentSessionId: 'sess-parent',
        depth: 1
      },
      profile: projection.profile
    }
  }
]

function runSnapshotOf(projectionOfRun: SubagentActivityProjection, overrides: Partial<RunSnapshot>): RunSnapshot {
  return {
    runId: projectionOfRun.childRunId,
    kind: 'agent',
    workspaceId: 'D:/workspace',
    sessionId: projectionOfRun.childSessionId,
    messageId: 'msg',
    status: 'running',
    sequence: 5,
    pendingInteractions: [],
    currentAttempt: null,
    progress: null,
    lastHeartbeatAt: 5,
    createdAt: 1,
    updatedAt: 5,
    ...overrides
  }
}

describe('subagent projection store', () => {
  beforeEach(() => {
    useSubagentProjectionStore.getState().resetForTests()
    vi.stubGlobal('window', {
      api: {
        invoke: vi.fn(async (channel: string) =>
          channel === 'subagent:list-projections' ||
          channel === 'subagent:list-projection-summaries'
            ? [projection]
            : null
        )
      }
    })
  })

  it('用 session lineage 建索引并以 IPC projection 水合 durable status', async () => {
    useSubagentProjectionStore.getState().syncSessionList(sessions)
    await useSubagentProjectionStore.getState().refreshParent('sess-parent')

    const state = useSubagentProjectionStore.getState()
    expect(state.childRunIdsByParentSessionId['sess-parent']).toEqual(['run-child'])
    expect(selectSubagentByParentToolCallId(state, 'call-task')).toEqual(projection)
  })

  it('只接受 identity 匹配的 child run snapshot', () => {
    useSubagentProjectionStore.getState().hydrateParent('sess-parent', [projection])
    useSubagentProjectionStore.getState().applyRunSnapshot({
      runId: 'other-run',
      kind: 'agent',
      workspaceId: 'D:/workspace',
      sessionId: 'sess-child',
      messageId: 'msg',
      status: 'failed',
      sequence: 2,
      pendingInteractions: [],
      currentAttempt: null,
      progress: null,
      lastHeartbeatAt: 2,
      createdAt: 1,
      updatedAt: 2
    })
    expect(useSubagentProjectionStore.getState().byChildRunId['run-child'].status).toBe('running')
  })

  it('拒绝迟到的低 sequence IPC，并在 relation 删除后清理索引', () => {
    const newest = { ...projection, sequence: 8, status: 'completed' as const }
    useSubagentProjectionStore.getState().hydrateParent('sess-parent', [newest])
    useSubagentProjectionStore.getState().hydrateParent('sess-parent', [
      { ...projection, sequence: 7, status: 'running' }
    ])

    expect(useSubagentProjectionStore.getState().byChildRunId['run-child']).toEqual(newest)

    useSubagentProjectionStore.getState().syncSessionList([sessions[0]])
    expect(useSubagentProjectionStore.getState().byChildRunId).toEqual({})
    expect(useSubagentProjectionStore.getState().childRunIdsByParentSessionId).toEqual({})
  })

  it('同 sequence 的轻投影不覆盖已水合的终态摘要', () => {
    const detailed = {
      ...projection,
      status: 'completed' as const,
      sequence: 8,
      summary: 'durable summary',
      artifactCount: 2
    }
    useSubagentProjectionStore.getState().hydrateParent('sess-parent', [detailed])
    useSubagentProjectionStore.getState().hydrateParent('sess-parent', [{
      ...projection,
      status: 'completed',
      sequence: 8
    }])
    expect(useSubagentProjectionStore.getState().byChildRunId['run-child']).toEqual(detailed)
  })

  it('同一子会话两个 run 的投影并存，applyRunSnapshot 只命中对应 run', () => {
    const followup: SubagentActivityProjection = {
      ...projection,
      childRunId: 'run-followup',
      parentToolCallId: 'call-followup',
      taskLabel: 'Continue runtime',
      sequence: 3,
      startedAt: 200
    }
    useSubagentProjectionStore.getState().hydrateParent('sess-parent', [projection, followup])

    const state = useSubagentProjectionStore.getState()
    // 出生 run 与 followup run 各占一条，互不覆盖
    expect(state.byChildRunId['run-child'].taskLabel).toBe('Inspect runtime')
    expect(state.byChildRunId['run-followup'].taskLabel).toBe('Continue runtime')
    expect(state.childRunIdsByParentSessionId['sess-parent']).toEqual(['run-child', 'run-followup'])
    // 两个不同 parentToolCallId 各自指向正确的 run
    expect(selectSubagentByParentToolCallId(state, 'call-task')?.childRunId).toBe('run-child')
    expect(selectSubagentByParentToolCallId(state, 'call-followup')?.childRunId).toBe('run-followup')

    useSubagentProjectionStore.getState().applyRunSnapshot(
      runSnapshotOf(followup, {
        status: 'failed',
        sequence: 6,
        createdAt: 250,
        turnStartedAt: 250,
        updatedAt: 260
      })
    )
    const after = useSubagentProjectionStore.getState()
    expect(after.byChildRunId['run-followup'].status).toBe('failed')
    expect(after.byChildRunId['run-followup'].completedAt).toBe(260)
    // 另一条 run 的投影不受影响
    expect(after.byChildRunId['run-child'].status).toBe('running')

    // 会话级视图（如子会话头部的停止按钮）取最新 run
    expect(selectLatestSubagentByChildSessionId(after, 'sess-child')?.childRunId).toBe('run-followup')
  })
})
