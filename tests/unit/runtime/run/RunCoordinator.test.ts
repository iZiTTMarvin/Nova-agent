/**
 * RunCoordinator / InteractionInbox / RunStore 单测
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RunStore } from '../../../../src/runtime/run/RunStore'
import { RunCoordinator } from '../../../../src/runtime/run/RunCoordinator'

describe('RunCoordinator', () => {
  let tmpDir: string
  let store: RunStore
  let coord: RunCoordinator

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-run-'))
    store = new RunStore({ runsRoot: tmpDir })
    coord = new RunCoordinator({ store })
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('startRun → markRunning → snapshot 可查询且 sequence 递增', () => {
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's1'
    })
    expect(snap.status).toBe('queued')
    expect(snap.sequence).toBe(1)

    const running = coord.markRunning(snap.runId, 'msg_1')
    expect(running?.status).toBe('running')
    expect(running?.messageId).toBe('msg_1')
    expect(running!.sequence).toBeGreaterThan(snap.sequence)
    expect(running?.turnStartedAt).toBeTruthy()

    const loaded = store.loadSnapshot(snap.runId)
    expect(loaded?.status).toBe('running')
    expect(coord.getSnapshotForSession('s1')?.runId).toBe(snap.runId)
  })

  it('terminal 只能提交一次', () => {
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's1'
    })
    coord.markRunning(snap.runId)
    const t1 = coord.commitTerminal({ runId: snap.runId, status: 'completed' })
    expect(t1?.status).toBe('completed')
    const seq = t1!.sequence

    const t2 = coord.commitTerminal({ runId: snap.runId, status: 'failed', reason: 'again' })
    expect(t2?.status).toBe('completed')
    expect(t2?.sequence).toBe(seq)
  })

  it('InteractionInbox 持久化并支持幂等回答', () => {
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's1',
      messageId: 'm1'
    })
    coord.markRunning(snap.runId, 'm1')

    const inter = coord.inbox.enqueue({
      runId: snap.runId,
      sessionId: 's1',
      messageId: 'm1',
      type: 'askQuestion',
      interactionId: 'ask_1',
      payload: { requestId: 'ask_1', questions: [] }
    })
    expect(coord.getSnapshot(snap.runId)?.status).toBe('waiting_user')
    expect(store.loadSnapshot(snap.runId)?.pendingInteractions).toHaveLength(1)

    const r1 = coord.inbox.answer({
      interactionId: inter.interactionId,
      commandId: 'cmd_1',
      expectedVersion: inter.version,
      outcome: 'answered',
      payload: { answers: [] }
    })
    expect(r1.ok).toBe(true)

    const r2 = coord.inbox.answer({
      interactionId: inter.interactionId,
      commandId: 'cmd_1',
      expectedVersion: inter.version,
      outcome: 'answered'
    })
    expect(r2.ok).toBe(true) // 同 commandId 幂等返回缓存

    const r3 = coord.inbox.answer({
      interactionId: inter.interactionId,
      commandId: 'cmd_2',
      expectedVersion: inter.version,
      outcome: 'answered'
    })
    expect(r3.ok).toBe(false)
    if (!r3.ok) expect(r3.code).toBe('already_answered')
  })

  it('terminal hook exactly-once', async () => {
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's1'
    })
    coord.markRunning(snap.runId)
    let calls = 0
    coord.onTerminalHook('onCancel', () => {
      calls += 1
    })
    coord.beginCancel(snap.runId)
    const term = coord.commitTerminal({
      runId: snap.runId,
      status: 'cancelled',
      terminalTransitionId: 'tid_1'
    })
    expect(term?.status).toBe('cancelled')
    // 给 async hook 一点时间
    await new Promise(r => setTimeout(r, 20))
    expect(calls).toBe(1)

    // 再次 fire 同 key 应被去重（内部 hasFired）
    expect(coord.hasFiredTerminalHook(snap.runId, 'tid_1', 'onCancel')).toBe(true)
  })

  it('工具对账 prepared→executing→committed；启动扫描标记 interrupted', () => {
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's1'
    })
    coord.markRunning(snap.runId, 'm1')
    coord.recordToolPhase(snap.runId, 'tc1', 'write', 'prepared', { idempotent: false })
    coord.recordToolPhase(snap.runId, 'tc1', 'write', 'executing', { idempotent: false })
    coord.recordToolPhase(snap.runId, 'tc1', 'write', 'committed', { idempotent: false })
    coord.recordToolPhase(snap.runId, 'tc2', 'bash', 'executing', { idempotent: false })

    // 模拟进程重启：新 coordinator 扫描
    const coord2 = new RunCoordinator({ store })
    const interrupted = coord2.reconcileOnStartup()
    expect(interrupted.length).toBe(1)
    expect(interrupted[0].status).toBe('interrupted')
    const tc2 = interrupted[0].toolCommits?.find(c => c.toolCallId === 'tc2')
    expect(tc2?.phase).toBe('failed') // 非幂等未提交 → failed，不自动重放
    const tc1 = interrupted[0].toolCommits?.find(c => c.toolCallId === 'tc1')
    expect(tc1?.phase).toBe('committed')
  })

  it('cancel 流程：beginCancel → cancelling，commitTerminal → cancelled', () => {
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's1'
    })
    coord.markRunning(snap.runId)
    const c = coord.beginCancel(snap.runId)
    expect(c?.status).toBe('cancelling')
    const t = coord.commitTerminal({ runId: snap.runId, status: 'cancelled' })
    expect(t?.status).toBe('cancelled')
  })
})
