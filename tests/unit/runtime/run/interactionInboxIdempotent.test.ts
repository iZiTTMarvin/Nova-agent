/**
 * InteractionInbox firstApplied / duplicate 契约
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRunCoordinator } from '../../../../src/runtime/run'

describe('InteractionInbox firstApplied/duplicate', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-inbox-'))
  })

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('同一 commandId 连续提交两次：第二次 firstApplied=false，状态不变', () => {
    const coord = createRunCoordinator(tmp)
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: 'ws',
      sessionId: 's1',
      runId: 'run_ask1'
    })
    coord.markRunning(snap.runId, 'msg1')
    const inter = coord.inbox.enqueue({
      runId: snap.runId,
      sessionId: 's1',
      messageId: 'msg1',
      type: 'askQuestion',
      interactionId: 'ask_1',
      payload: { questions: [] }
    })

    const r1 = coord.inbox.answer({
      interactionId: 'ask_1',
      commandId: 'cmd_same',
      expectedVersion: inter.version,
      outcome: 'answered',
      payload: { answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }] }
    })
    expect(r1.ok).toBe(true)
    expect(r1.firstApplied).toBe(true)

    const r2 = coord.inbox.answer({
      interactionId: 'ask_1',
      commandId: 'cmd_same',
      expectedVersion: inter.version,
      outcome: 'answered',
      payload: { answers: [{ questionId: 'q1', selectedOptionIds: ['b'] }] }
    })
    expect(r2.ok).toBe(true)
    expect(r2.firstApplied).toBe(false)
    expect(r2.duplicate).toBe(true)

    // 交互只被更新一次
    const after = coord.findInteraction('ask_1')!
    expect(after.status).toBe('answered')
    expect(after.version).toBe(inter.version + 1)
  })

  it('permission 重复命令只生效一次', () => {
    const coord = createRunCoordinator(tmp)
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: 'ws',
      sessionId: 's1',
      runId: 'run_perm1'
    })
    coord.markRunning(snap.runId)
    const inter = coord.inbox.enqueue({
      runId: snap.runId,
      sessionId: 's1',
      messageId: 'm',
      type: 'permission',
      interactionId: 'perm_1',
      payload: { toolName: 'bash' }
    })

    const a = coord.inbox.answer({
      interactionId: 'perm_1',
      commandId: 'p_cmd',
      expectedVersion: inter.version,
      outcome: 'answered',
      payload: { decision: 'allow' }
    })
    const b = coord.inbox.answer({
      interactionId: 'perm_1',
      commandId: 'p_cmd',
      expectedVersion: inter.version,
      outcome: 'dismissed',
      payload: { decision: 'deny' }
    })
    expect(a.firstApplied).toBe(true)
    expect(b.firstApplied).toBe(false)
    expect(coord.findInteraction('perm_1')!.payload.decision).toBe('allow')
  })
})
