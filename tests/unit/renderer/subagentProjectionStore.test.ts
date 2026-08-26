import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  selectSubagentByParentToolCallId,
  useSubagentProjectionStore
} from '../../../src/renderer/features/subagents/projection'
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
    expect(state.childIdsByParentSessionId['sess-parent']).toEqual(['sess-child'])
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
    expect(useSubagentProjectionStore.getState().byChildSessionId['sess-child'].status).toBe('running')
  })

  it('拒绝迟到的低 sequence IPC，并在 relation 删除后清理索引', () => {
    const newest = { ...projection, sequence: 8, status: 'completed' as const }
    useSubagentProjectionStore.getState().hydrateParent('sess-parent', [newest])
    useSubagentProjectionStore.getState().hydrateParent('sess-parent', [
      { ...projection, sequence: 7, status: 'running' }
    ])

    expect(useSubagentProjectionStore.getState().byChildSessionId['sess-child']).toEqual(newest)

    useSubagentProjectionStore.getState().syncSessionList([sessions[0]])
    expect(useSubagentProjectionStore.getState().byChildSessionId).toEqual({})
    expect(useSubagentProjectionStore.getState().childIdsByParentSessionId).toEqual({})
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
    expect(useSubagentProjectionStore.getState().byChildSessionId['sess-child']).toEqual(detailed)
  })
})
