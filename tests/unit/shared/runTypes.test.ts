import { describe, expect, it } from 'vitest'
import type { RunSnapshot } from '../../../src/shared/run/types'
import type { XForgeRunState } from '../../../src/shared/xforge/types'
import { createInitialXForgeRunState } from '../../../src/runtime/workflow/xforge/runState'

describe('shared run / xforge DTO serialization', () => {
  it('XForgeRunState round-trips through JSON', () => {
    const state: XForgeRunState = createInitialXForgeRunState({
      reviewOnly: true,
      planVersion: 1,
      workspaceRevision: 2,
      hasValidatedPlan: true,
      hasValidScopePass: true
    })
    const parsed = JSON.parse(JSON.stringify(state)) as XForgeRunState
    expect(parsed).toEqual(state)
  })

  it('RunSnapshot with xforge slice round-trips through JSON', () => {
    const snapshot: RunSnapshot = {
      runId: 'run-1',
      kind: 'xforge',
      workspaceId: 'ws-1',
      sessionId: 'sess-1',
      messageId: 'msg-1',
      status: 'running',
      sequence: 3,
      pendingInteractions: [],
      currentAttempt: null,
      progress: null,
      lastHeartbeatAt: 1,
      createdAt: 1,
      updatedAt: 2,
      xforge: createInitialXForgeRunState({ currentStage: 'plan' })
    }
    const parsed = JSON.parse(JSON.stringify(snapshot)) as RunSnapshot
    expect(parsed).toEqual(snapshot)
  })
})
