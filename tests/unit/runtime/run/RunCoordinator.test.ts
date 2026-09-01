/**
 * RunCoordinator / InteractionInbox / RunStore 单测
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

  it('completed + incompleteReason 落盘并在重载后保留', () => {
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    coord.markRunning(snap.runId)
    const terminal = coord.commitTerminal({
      runId: snap.runId,
      status: 'completed',
      incompleteReason: 'max_rounds'
    })

    expect(terminal?.incompleteReason).toBe('max_rounds')
    // snapshot 整体序列化 → 磁盘 round-trip 保留字段
    const reloaded = store.loadSnapshot(snap.runId)
    expect(reloaded?.status).toBe('completed')
    expect(reloaded?.incompleteReason).toBe('max_rounds')
  })

  it('cancelled / failed 终态强制清空 incompleteReason（取消优先于截断）', () => {
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    coord.markRunning(snap.runId)
    const terminal = coord.commitTerminal({
      runId: snap.runId,
      status: 'cancelled',
      incompleteReason: 'max_rounds'
    })

    expect(terminal?.status).toBe('cancelled')
    expect(terminal?.incompleteReason).toBeUndefined()
    expect(store.loadSnapshot(snap.runId)?.incompleteReason).toBeUndefined()
  })

  it('会话删除只回收终态 run，非终态 fail closed', () => {
    const terminal = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's-terminal' })
    coord.markRunning(terminal.runId)
    coord.commitTerminal({ runId: terminal.runId, status: 'completed' })

    const active = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's-active' })
    coord.markRunning(active.runId)

    expect(() => coord.deleteRunsForSessions(new Set(['s-active']))).toThrow(/尚未终态/)
    expect(store.loadSnapshot(active.runId)).not.toBeNull()

    expect(coord.deleteRunsForSessions(new Set(['s-terminal']))).toBe(1)
    expect(store.loadSnapshot(terminal.runId)).toBeNull()
    expect(coord.getSnapshotForSession('s-terminal')).toBeNull()
  })

  it('listSnapshotsForSession：createdAt 升序稳定，内存快照优先于磁盘', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      coord.startRun({ kind: 'agent', runId: 'run-b', workspaceId: '/ws', sessionId: 's1' })
      coord.markRunning('run-b', 'm1')
      vi.setSystemTime(2_000)
      coord.startRun({ kind: 'agent', runId: 'run-z', workspaceId: '/ws', sessionId: 's1' })
      coord.startRun({ kind: 'agent', runId: 'run-a', workspaceId: '/ws', sessionId: 's1' })

      const cold = new RunCoordinator({ store })
      // createdAt 升序；同刻创建的 run-z / run-a 按 runId 字典序稳定排序
      expect(cold.listSnapshotsForSession('s1').map(s => s.runId)).toEqual([
        'run-b',
        'run-a',
        'run-z'
      ])
      expect(cold.listSnapshotsForSession('s-other')).toEqual([])

      // 冷 coordinator 把 run-b 提交终态写盘；热 coordinator 内存中的 running 版本必须优先
      cold.commitTerminal({ runId: 'run-b', status: 'completed' })
      const hot = coord.listSnapshotsForSession('s1').find(s => s.runId === 'run-b')
      expect(hot?.status).toBe('running')
      expect(cold.listSnapshotsForSession('s1').find(s => s.runId === 'run-b')?.status).toBe('completed')
    } finally {
      vi.useRealTimers()
    }
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

  it('启动对账把未决交互收敛为终态，不残留「等待你处理」状态', () => {
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 'child' })
    coord.markRunning(snap.runId, 'msg-child')
    coord.inbox.enqueue({
      runId: snap.runId,
      sessionId: 'child',
      messageId: 'msg-child',
      type: 'permission',
      interactionId: 'permission-child',
      payload: { requestId: 'permission-child', toolName: 'bash' }
    })
    coord.updateInteraction(snap.runId, 'permission-child', {
      status: 'submitting',
      version: 2
    })

    const coord2 = new RunCoordinator({ store })
    const [interrupted] = coord2.reconcileOnStartup()

    expect(interrupted.status).toBe('interrupted')
    expect(interrupted.pendingInteractions.map(i => i.status)).toEqual(['cancelled'])
    expect(interrupted.pendingInteractions[0]?.version).toBe(3)
    // 落盘与内存一致：重启后不再有「等待你处理」残留
    expect(store.loadSnapshot(snap.runId)?.pendingInteractions[0]?.status).toBe('cancelled')
    expect(coord2.inbox.listPendingForSession('child')).toHaveLength(0)
    expect(coord2.listWaitingSessions()).toEqual([])
  })

  it('waiting_user + pending 交互重启后：run interrupted、交互终态、不计入等待徽标', () => {
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's1',
      messageId: 'm1'
    })
    coord.markRunning(snap.runId, 'm1')
    coord.inbox.enqueue({
      runId: snap.runId,
      sessionId: 's1',
      messageId: 'm1',
      type: 'askQuestion',
      interactionId: 'ask_1',
      payload: { requestId: 'ask_1', questions: [] }
    })
    expect(coord.getSnapshot(snap.runId)?.status).toBe('waiting_user')
    expect(coord.listWaitingSessions()).toHaveLength(1)

    const coord2 = new RunCoordinator({ store })
    const [reconciled] = coord2.reconcileOnStartup()

    expect(reconciled.status).toBe('interrupted')
    expect(reconciled.pendingInteractions.every(i => i.status === 'cancelled')).toBe(true)
    expect(coord2.listWaitingSessions()).toEqual([])
    // interrupted 不占用 turn：新消息可正常开新轮次
    expect(coord2.hasActiveRunForSession('s1')).toBe(false)
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

  it('turnDraft：工具边界落盘，finalize 后可清除', () => {
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's1'
    })
    coord.markRunning(snap.runId, 'msg_draft')
    coord.upsertTurnDraft(snap.runId, {
      messageId: 'msg_draft',
      blocks: [
        { type: 'tool', toolCallId: 'tc1', toolName: 'write', status: 'success', result: 'ok' }
      ]
    })
    const mid = store.loadSnapshot(snap.runId)
    expect(mid?.turnDraft?.messageId).toBe('msg_draft')
    expect(mid?.turnDraft?.finalized).toBe(false)
    expect(mid?.turnDraft?.blocks).toHaveLength(1)

    // 模拟进程重启：草稿仍在
    const coord2 = new RunCoordinator({ store })
    const reloaded = coord2.getSnapshot(snap.runId)
    expect(reloaded?.turnDraft?.blocks[0]).toMatchObject({ toolCallId: 'tc1', status: 'success' })

    coord2.upsertTurnDraft(snap.runId, {
      messageId: 'msg_draft',
      blocks: reloaded!.turnDraft!.blocks,
      finalized: true
    })
    coord2.clearTurnDraft(snap.runId)
    expect(store.loadSnapshot(snap.runId)?.turnDraft).toBeNull()
  })

  it('commandId 回执跨重启幂等', () => {
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
      interactionId: 'ask_persist',
      payload: { questions: [] }
    })
    const r1 = coord.inbox.answer({
      interactionId: inter.interactionId,
      commandId: 'cmd_persist_1',
      expectedVersion: inter.version,
      outcome: 'answered',
      payload: { answers: [] }
    })
    expect(r1.ok).toBe(true)
    expect(store.loadSnapshot(snap.runId)?.commandAcks?.some(a => a.commandId === 'cmd_persist_1')).toBe(
      true
    )

    // 新进程：内存 Map 空，应从 snapshot 恢复
    const coord2 = new RunCoordinator({ store })
    const r2 = coord2.inbox.answer({
      interactionId: 'ask_persist',
      commandId: 'cmd_persist_1',
      expectedVersion: 1,
      outcome: 'answered'
    })
    expect(r2.ok).toBe(true)
  })

  it('terminal outbox 跨重启标记 delivered，不再重复触发', async () => {
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's1'
    })
    coord.markRunning(snap.runId)
    let calls = 0
    coord.onTerminalHook('onComplete', () => {
      calls += 1
    })
    coord.commitTerminal({
      runId: snap.runId,
      status: 'completed',
      terminalTransitionId: 'tid_outbox'
    })
    await new Promise(r => setTimeout(r, 30))
    expect(calls).toBe(1)
    const disk = store.loadSnapshot(snap.runId)
    expect(disk?.terminalOutbox?.some(e => e.key.includes('tid_outbox') && e.status === 'delivered')).toBe(
      true
    )

    const coord2 = new RunCoordinator({ store })
    let calls2 = 0
    coord2.onTerminalHook('onComplete', () => {
      calls2 += 1
    })
    // 再次提交同终态应被硬终态短路；hasFired 应从 outbox 读到
    expect(coord2.hasFiredTerminalHook(snap.runId, 'tid_outbox', 'onComplete')).toBe(true)
    expect(calls2).toBe(0)
  })
})
