/**
 * RunCoordinator / InteractionInbox / RunStore 单测
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RunStore } from '../../../../src/runtime/run/RunStore'
import { RunCoordinator } from '../../../../src/runtime/run/RunCoordinator'
import type { RunSnapshot } from '../../../../src/shared/run/types'
import * as atomicFile from '../../../../src/runtime/storage/atomicFile'
import { applyAgentEventToRun } from '../../../../src/runtime/agent/turn'
import {
  decodeSubagentDeliveryBinding,
  deriveSubagentNotificationId,
  resolveDispatchExecution,
  type SubagentRelayTrigger,
  type SubagentRunDispatch
} from '../../../../src/shared/run/types'

const validDispatch: SubagentRunDispatch = {
  version: 1,
  callKind: 'task',
  parentSessionId: 's-parent',
  parentRunId: 'run-parent',
  parentMessageId: 'msg-parent',
  execution: 'background_read_only',
  topParentSessionId: 's-parent'
}

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

  it('旧中断轮晚于新轮更新，冷启动仍选择新轮', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const old = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
      coord.upsertTurnDraft(old.runId, { messageId: 'old-message', blocks: [{ type: 'text', content: 'interrupted work' }] })
      coord.commitTerminal({ runId: old.runId, status: 'interrupted' })
      vi.setSystemTime(2_000)
      const latest = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
      coord.commitTerminal({ runId: latest.runId, status: 'failed' })
      vi.setSystemTime(3_000)
      coord.clearTurnDraft(old.runId)
      expect(store.findSnapshotsBySession('s1')[0].runId).toBe(old.runId)
      expect(new RunCoordinator({ store }).getSnapshotForSession('s1')?.runId).toBe(latest.runId)
    } finally {
      vi.useRealTimers()
    }
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

  it('批量查询保留事件重放、会话隔离、内存优先与返回值隔离', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      for (const [runId, sessionId] of [['run-a', 's1'], ['run-b', 's2'], ['run-other', 's3']]) {
        coord.startRun({ kind: 'agent', runId, workspaceId: '/ws', sessionId })
      }
      const base = store.loadSnapshot('run-b')!
      fs.appendFileSync(path.join(tmpDir, 'run-b', 'events.jsonl'), JSON.stringify({
        runId: 'run-b', sequence: base.sequence + 1, type: 'terminal', at: 2_000,
        payload: { status: 'failed', reason: 'replayed' }
      }) + '\n')
      const cold = new RunCoordinator({ store })
      const sessions = new Set(['s1', 's2', 'missing'])
      const snapshots = cold.listSnapshotsForSessions(sessions)
      expect(snapshots.map(snap => [snap.runId, snap.status])).toEqual([
        ['run-a', 'queued'], ['run-b', 'failed']
      ])
      expect(store.loadSnapshot('run-b')).toMatchObject({ sequence: base.sequence + 1, terminalReason: 'replayed' })
      expect(coord.listSnapshotsForSessions(sessions).map(snap => snap.status)).toEqual(['queued', 'queued'])
      snapshots[0].status = 'cancelled'
      expect(cold.listSnapshotsForSession('s1')[0].status).toBe('queued')
      vi.setSystemTime(3_000)
      coord.startRun({ kind: 'agent', runId: 'run-new', workspaceId: '/ws', sessionId: 's2' })
      expect(cold.listSnapshotsForSessions(sessions).map(snap => snap.runId)).toEqual(['run-a', 'run-b', 'run-new'])
      expect(cold.listSnapshotsForSessions(new Set())).toEqual([])
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

  it('一次工具调用+结果边界：各只落盘一次并广播一次，事件序号连续', () => {
    const broadcasts: Array<{ type: string; sequence: number }> = []
    const txSpy = vi.spyOn(store, 'commitTransaction')
    const batchSpy = vi.spyOn(store, 'commitTransactionBatch')
    coord = new RunCoordinator({
      store,
      onSnapshot: (_snap, event) => {
        broadcasts.push({ type: event.type, sequence: event.sequence })
      }
    })
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    coord.markRunning(snap.runId, 'msg_tool')
    const ctx = {
      runCoordinator: coord,
      runId: snap.runId,
      resourceOwnerRunId: snap.runId,
      sessionId: 's1'
    }
    const applyBoundary = (event: Parameters<typeof applyAgentEventToRun>[1]): void => {
      applyAgentEventToRun(ctx, event, () => {
        coord.upsertTurnDraft(snap.runId, {
          messageId: 'msg_tool',
          blocks: [{ type: 'tool', toolCallId: 'tc1', toolName: 'read', status: 'running' }]
        })
      })
    }

    const beforeCall = coord.getSnapshot(snap.runId)!.sequence
    txSpy.mockClear()
    batchSpy.mockClear()
    broadcasts.length = 0

    applyBoundary({
      type: 'tool_call',
      messageId: 'msg_tool',
      toolCallId: 'tc1',
      toolName: 'read',
      args: {}
    })
    expect(txSpy).not.toHaveBeenCalled()
    expect(batchSpy).toHaveBeenCalledTimes(1)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]?.type).toBe('turn_draft_upsert')
    const afterCall = coord.getSnapshot(snap.runId)!.sequence
    expect(afterCall).toBe(beforeCall + 4)
    const callEvents = store.loadEvents(snap.runId).events.filter(event => event.sequence > beforeCall)
    expect(callEvents.map(event => event.type)).toEqual([
      'heartbeat',
      'tool_phase',
      'tool_phase',
      'turn_draft_upsert'
    ])
    expect(callEvents.map(event => event.sequence)).toEqual([
      beforeCall + 1,
      beforeCall + 2,
      beforeCall + 3,
      beforeCall + 4
    ])
    expect(callEvents[1]?.payload).toMatchObject({ phase: 'prepared' })
    expect(callEvents[2]?.payload).toMatchObject({ phase: 'executing' })
    expect(store.loadSnapshot(snap.runId)?.sequence).toBe(afterCall)
    expect(coord.getSnapshot(snap.runId)?.toolCommits?.[0]?.phase).toBe('executing')

    const beforeResult = afterCall
    txSpy.mockClear()
    batchSpy.mockClear()
    broadcasts.length = 0

    applyBoundary({
      type: 'tool_result',
      messageId: 'msg_tool',
      toolCallId: 'tc1',
      toolName: 'read',
      result: 'ok'
    })
    expect(txSpy).not.toHaveBeenCalled()
    expect(batchSpy).toHaveBeenCalledTimes(1)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]?.type).toBe('turn_draft_upsert')
    const afterResult = coord.getSnapshot(snap.runId)!.sequence
    expect(afterResult).toBe(beforeResult + 2)
    const resultEvents = store.loadEvents(snap.runId).events.filter(event => event.sequence > beforeResult)
    expect(resultEvents.map(event => event.type)).toEqual(['tool_phase', 'turn_draft_upsert'])
    expect(resultEvents.map(event => event.sequence)).toEqual([beforeResult + 1, beforeResult + 2])
    expect(store.loadSnapshot(snap.runId)?.sequence).toBe(afterResult)
    expect(coord.getSnapshot(snap.runId)?.toolCommits?.[0]?.phase).toBe('committed')
  })

  it('嵌套 batch 合并为一次落盘；空 batch 不写盘', () => {
    const broadcasts: Array<string> = []
    const txSpy = vi.spyOn(store, 'commitTransaction')
    const batchSpy = vi.spyOn(store, 'commitTransactionBatch')
    coord = new RunCoordinator({
      store,
      onSnapshot: (_snap, event) => {
        broadcasts.push(event.type)
      }
    })
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    coord.markRunning(snap.runId, 'msg_tool')
    const before = coord.getSnapshot(snap.runId)!.sequence
    txSpy.mockClear()
    batchSpy.mockClear()
    broadcasts.length = 0

    coord.batch(snap.runId, () => {})
    expect(txSpy).not.toHaveBeenCalled()
    expect(batchSpy).not.toHaveBeenCalled()
    expect(broadcasts).toHaveLength(0)
    expect(coord.getSnapshot(snap.runId)?.sequence).toBe(before)

    coord.batch(snap.runId, () => {
      coord.heartbeat(snap.runId, { label: 'outer' })
      coord.batch(snap.runId, () => {
        coord.recordToolPhase(snap.runId, 'tc1', 'read', 'prepared')
      })
      coord.upsertTurnDraft(snap.runId, {
        messageId: 'msg_tool',
        blocks: [{ type: 'text', content: 'draft' }]
      })
    })
    expect(txSpy).not.toHaveBeenCalled()
    expect(batchSpy).toHaveBeenCalledTimes(1)
    expect(broadcasts).toEqual(['turn_draft_upsert'])
    expect(coord.getSnapshot(snap.runId)?.sequence).toBe(before + 3)
  })

  it('单独 heartbeat 仍立即落盘', () => {
    const broadcasts: Array<string> = []
    const txSpy = vi.spyOn(store, 'commitTransaction')
    coord = new RunCoordinator({
      store,
      onSnapshot: (_snap, event) => {
        broadcasts.push(event.type)
      }
    })
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    coord.markRunning(snap.runId)
    txSpy.mockClear()
    broadcasts.length = 0
    coord.heartbeat(snap.runId, { label: '思考中' })
    expect(txSpy).toHaveBeenCalledTimes(1)
    expect(broadcasts).toEqual(['heartbeat'])
  })

  it('启动对账只重放未结束的任务，已结束的不读事件日志', () => {
    for (let i = 0; i < 40; i++) {
      const snap = coord.startRun({
        kind: 'agent',
        workspaceId: '/ws',
        sessionId: `done-${i}`,
        runId: `run_done_${i}`
      })
      coord.markRunning(snap.runId, `m${i}`)
      coord.commitTerminal({ runId: snap.runId, status: 'completed' })
    }
    const live = coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 'live',
      runId: 'run_live'
    })
    coord.markRunning(live.runId, 'm-live')

    const loadEvents = vi.spyOn(store, 'loadEvents')
    const coord2 = new RunCoordinator({ store })
    const interrupted = coord2.reconcileOnStartup()
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]!.runId).toBe('run_live')
    expect(interrupted[0]!.status).toBe('interrupted')
    expect(loadEvents.mock.calls.map(call => call[0])).toEqual(['run_live'])
  })

  it('终态后投递绑定可更新、幂等且不碰 generation/业务终态', () => {
    coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's-child',
      runId: 'run_child_bind',
      dispatch: validDispatch
    })
    coord.markRunning('run_child_bind')
    coord.bindExecutionGeneration('run_child_bind', 3)
    coord.commitTerminal({
      runId: 'run_child_bind',
      status: 'completed',
      terminalTransitionId: 'tid_x'
    })
    const before = coord.getSnapshot('run_child_bind')!.sequence

    const updated = coord.updateDeliveryBinding('run_child_bind', {
      boundRunId: 'run-parent',
      boundSessionId: 's-parent'
    })
    expect(updated?.deliveryBinding?.version).toBe(1)
    expect(updated?.deliveryBinding?.boundRunId).toBe('run-parent')
    expect(updated?.status).toBe('completed')
    expect(updated?.executionGeneration).toBe(3)
    expect(updated?.terminalTransitionId).toBe('tid_x')
    expect(updated!.sequence).toBeGreaterThan(before)

    // 相同 patch 幂等：不重复落盘
    const again = coord.updateDeliveryBinding('run_child_bind', {
      boundRunId: 'run-parent',
      boundSessionId: 's-parent'
    })
    expect(again!.sequence).toBe(updated!.sequence)

    expect(store.loadSnapshot('run_child_bind')?.deliveryBinding?.boundRunId).toBe('run-parent')

    const paused = coord.updateDeliveryBinding('run_child_bind', { paused: true })
    expect(paused?.deliveryBinding?.paused).toBe(true)
    expect(paused?.deliveryBinding?.boundRunId).toBe('run-parent')
  })

  it('终态快照落后尾部投递事件，启动对账收敛且普通历史不读事件', () => {
    coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's-a',
      runId: 'run_proto_a',
      dispatch: validDispatch
    })
    coord.markRunning('run_proto_a')
    coord.commitTerminal({ runId: 'run_proto_a', status: 'completed' })
    coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's-b', runId: 'run_plain_b' })
    coord.markRunning('run_plain_b')
    coord.commitTerminal({ runId: 'run_plain_b', status: 'completed' })

    // 模拟崩溃窗口：投递事件已落盘、快照未写回
    const snapA = store.loadSnapshot('run_proto_a')!
    fs.appendFileSync(
      path.join(tmpDir, 'run_proto_a', 'events.jsonl'),
      JSON.stringify({
        runId: 'run_proto_a',
        sequence: snapA.sequence + 1,
        type: 'delivery_binding',
        at: Date.now(),
        payload: { binding: { version: 1, boundRunId: 'run-parent', updatedAt: Date.now() } }
      }) + '\n'
    )

    const loadEvents = vi.spyOn(store, 'loadEvents')
    const coord2 = new RunCoordinator({ store })
    coord2.reconcileOnStartup()

    const calls = loadEvents.mock.calls.map(call => call[0])
    expect(calls).toContain('run_proto_a')
    expect(calls).not.toContain('run_plain_b')
    const after = store.loadSnapshot('run_proto_a')!
    expect(after.deliveryBinding?.boundRunId).toBe('run-parent')
    expect(after.sequence).toBe(snapA.sequence + 1)
  })

  it('尾部事件先收敛再更新绑定：不产生重复序号、不掩埋已落盘绑定', () => {
    coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's-child',
      runId: 'run_tail_conflict',
      dispatch: validDispatch
    })
    coord.markRunning('run_tail_conflict')
    coord.commitTerminal({ runId: 'run_tail_conflict', status: 'completed' })

    // 模拟崩溃窗口：绑定事件已落盘、快照未写回
    const snapA = store.loadSnapshot('run_tail_conflict')!
    fs.appendFileSync(
      path.join(tmpDir, 'run_tail_conflict', 'events.jsonl'),
      JSON.stringify({
        runId: 'run_tail_conflict',
        sequence: snapA.sequence + 1,
        type: 'delivery_binding',
        at: Date.now(),
        payload: { binding: { version: 1, boundRunId: 'run-parent', updatedAt: Date.now() } }
      }) + '\n'
    )

    // 冷启动顺序：先收敛尾部事件，再处理控制意图的绑定更新（失效化/暂停）
    const cold = new RunCoordinator({ store })
    cold.convergeProtocolTailsOnStartup()
    cold.updateDeliveryBinding('run_tail_conflict', { paused: true })

    const coldStore = new RunStore({ runsRoot: tmpDir })
    const persisted = coldStore.loadSnapshotWithReplay('run_tail_conflict')!
    // 已落盘的 boundRunId 不被旧快照基线的提交掩埋，新更新在其上叠加
    expect(persisted.deliveryBinding).toEqual(expect.objectContaining({
      boundRunId: 'run-parent',
      paused: true
    }))
    const { events } = coldStore.loadEvents('run_tail_conflict')
    const sequences = events.map(event => event.sequence)
    expect(new Set(sequences).size).toBe(sequences.length)
    expect(sequences[sequences.length - 1]).toBeGreaterThan(snapA.sequence)
  })

  it('updateDeliveryBinding 落盘失败回滚内存，重试真正重新落盘不假成功', () => {
    class FailingCommitStore extends RunStore {
      public failNextCommit = false
      override commitTransaction(
        nextSnapshot: Parameters<RunStore['commitTransaction']>[0],
        eventType: Parameters<RunStore['commitTransaction']>[1],
        payload?: Parameters<RunStore['commitTransaction']>[2]
      ) {
        if (this.failNextCommit) {
          this.failNextCommit = false
          throw new Error('disk full')
        }
        return super.commitTransaction(nextSnapshot, eventType, payload)
      }
    }
    const failing = new FailingCommitStore({ runsRoot: tmpDir })
    const failingCoord = new RunCoordinator({ store: failing })
    failingCoord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's-bind-fail',
      runId: 'run_bind_fail'
    })
    failingCoord.commitTerminal({ runId: 'run_bind_fail', status: 'completed' })

    failing.failNextCommit = true
    expect(() =>
      failingCoord.updateDeliveryBinding('run_bind_fail', { invalidatedReason: 'stop:op' })
    ).toThrow(/disk full/)
    // 内存已回滚：失效化未生效，后续重试不会被幂等判断吞掉
    expect(failingCoord.getSnapshot('run_bind_fail')?.deliveryBinding?.invalidatedReason)
      .toBeUndefined()

    failingCoord.updateDeliveryBinding('run_bind_fail', { invalidatedReason: 'stop:op' })

    // 冷读验证：重试真正落盘，事件序号严格递增无重复
    const coldStore = new RunStore({ runsRoot: tmpDir })
    expect(coldStore.loadSnapshot('run_bind_fail')?.deliveryBinding?.invalidatedReason)
      .toBe('stop:op')
    const { events } = coldStore.loadEvents('run_bind_fail')
    const sequences = events.map(event => event.sequence)
    expect(new Set(sequences).size).toBe(sequences.length)
  })

  it('事件已 fsync 而快照失败后，后续绑定更新保留已提交事实且序号唯一', () => {
    coord.startRun({
      kind: 'agent', workspaceId: '/ws', sessionId: 's-child',
      runId: 'run_snapshot_failure', dispatch: validDispatch
    })
    coord.markRunning('run_snapshot_failure')
    coord.commitTerminal({ runId: 'run_snapshot_failure', status: 'completed' })
    const write = atomicFile.atomicWriteFileSync
    const snapshotPath = path.join(tmpDir, 'run_snapshot_failure', 'snapshot.json')
    const fault = vi.spyOn(atomicFile, 'atomicWriteFileSync').mockImplementation((file, content, encoding) => {
      if (file === snapshotPath) throw new Error('snapshot write failed after fsync')
      write(file, content, encoding)
    })
    try {
      expect(() => coord.updateDeliveryBinding('run_snapshot_failure', { boundRunId: 'reserved-parent' }))
        .toThrow(/snapshot write failed/)
    } finally {
      fault.mockRestore()
    }

    coord.updateDeliveryBinding('run_snapshot_failure', { paused: true })

    const cold = new RunStore({ runsRoot: tmpDir })
    expect(cold.loadSnapshotWithReplay('run_snapshot_failure')?.deliveryBinding)
      .toMatchObject({ boundRunId: 'reserved-parent', paused: true })
    const sequences = cold.loadEvents('run_snapshot_failure').events.map(event => event.sequence)
    expect(new Set(sequences).size).toBe(sequences.length)
  })

  it('dispatch 未知版本失败关闭；腐坏记录在全盘扫描中被隔离', () => {
    coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's-bad',
      runId: 'run_bad_proto',
      dispatch: validDispatch
    })
    coord.markRunning('run_bad_proto')
    coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's-ok', runId: 'run_ok' })

    const snapPath = path.join(tmpDir, 'run_bad_proto', 'snapshot.json')
    const raw = JSON.parse(fs.readFileSync(snapPath, 'utf8')) as { dispatch: { version: number } }
    raw.dispatch.version = 2
    fs.writeFileSync(snapPath, JSON.stringify(raw, null, 2))

    expect(() => store.loadSnapshot('run_bad_proto')).toThrow()
    const found = store.findSnapshotsBySessions(new Set(['s-ok']))
    expect(found.map(snap => snap.runId)).toEqual(['run_ok'])
  })

  it('旧记录无 dispatch 归一化为同步；通知 id 派生稳定；绑定 decoder 失败关闭', () => {
    expect(resolveDispatchExecution({})).toBe('sync')
    expect(resolveDispatchExecution({ dispatch: validDispatch })).toBe('background_read_only')

    const id = deriveSubagentNotificationId('run_c', 'tid_1')
    expect(deriveSubagentNotificationId('run_c', 'tid_1')).toBe(id)
    expect(id).toContain('run_c')
    expect(id).toContain('tid_1')
    expect(() => deriveSubagentNotificationId('', 'tid_1')).toThrow()
    expect(() => deriveSubagentNotificationId('run_c', '')).toThrow()

    expect(decodeSubagentDeliveryBinding(null)).toBeUndefined()
    expect(() => decodeSubagentDeliveryBinding({ version: 2 })).toThrow()
  })

  it('启动对账保留未执行的有效接力预约，其余非终态一律 interrupted', () => {
    const trigger = relayTriggerOf('run_relay_queued')
    coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's-relay',
      runId: 'run_relay_queued',
      relayTrigger: trigger
    })
    // 接力预约已进入执行：不再有效，按崩溃残留收敛
    coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's-relay',
      runId: 'run_relay_running',
      relayTrigger: relayTriggerOf('run_relay_running')
    })
    coord.markRunning('run_relay_running')
    coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's-plain',
      runId: 'run_plain_queued'
    })

    const cold = new RunCoordinator({ store })
    const interrupted = cold.reconcileOnStartup()

    expect(interrupted.map(snapshot => snapshot.runId).sort()).toEqual([
      'run_plain_queued',
      'run_relay_running'
    ])
    expect(cold.getSnapshot('run_relay_queued')?.status).toBe('queued')
    expect(cold.getSnapshot('run_relay_queued')?.terminalTransitionId).toBeUndefined()
    expect(store.loadSnapshot('run_relay_queued')?.status).toBe('queued')
    expect(cold.getSnapshot('run_relay_running')?.status).toBe('interrupted')
    expect(cold.getSnapshot('run_plain_queued')?.status).toBe('interrupted')
    // 保留的预约仍不占用 turn：用户消息可以正常进入该会话
    expect(cold.hasActiveRunForSession('s-relay')).toBe(false)
  })

  it('subscribe 在成功落盘后发布 clone，监听器异常隔离且不影响 commit', () => {
    const snapshots: RunSnapshot[] = []
    const listener = (snap: RunSnapshot): void => {
      snapshots.push(snap)
    }
    coord.subscribe(listener)

    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's-sub' })
    coord.markRunning(snap.runId, 'msg-sub')
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    // 发布的是 clone，修改不影响权威状态
    const first = snapshots[0]!
    first.status = 'failed'
    expect(coord.getSnapshot(snap.runId)?.status).toBe('running')

    // 监听器抛错时隔离记录，不破坏后续提交
    const errorListener = vi.fn(() => {
      throw new Error('listener boom')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    coord.subscribe(errorListener)
    coord.commitTerminal({ runId: snap.runId, status: 'completed' })
    expect(errorListener).toHaveBeenCalled()
    expect(coord.getSnapshot(snap.runId)?.status).toBe('completed')
    errorSpy.mockRestore()
  })

  it('subscribe 返回的 unsubscribe 幂等，调用后不再收到通知', () => {
    const received: string[] = []
    const unsubscribe = coord.subscribe((snap) => {
      received.push(snap.runId)
    })

    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's-unsub' })
    const before = received.length
    unsubscribe()
    unsubscribe() // 幂等

    coord.markRunning(snap.runId, 'msg-unsub')
    expect(received.length).toBe(before)
  })

  it('每个通用 subscriber 各自收到独立 clone，互不污染', () => {
    const firstSeen: RunStatus[] = []
    const secondSeen: RunStatus[] = []
    coord.subscribe((snap) => {
      // 第一个 listener 篡改收到的快照，不应影响第二个 listener
      firstSeen.push(snap.status)
      snap.status = 'failed'
    })
    coord.subscribe((snap) => {
      secondSeen.push(snap.status)
    })

    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's-clone' })
    coord.markRunning(snap.runId, 'msg-clone')
    // 第二个 listener 看到的是 running，不是被第一个篡改后的 failed
    expect(secondSeen.every(status => status !== 'failed')).toBe(true)
    expect(firstSeen.length).toBeGreaterThanOrEqual(2)
    expect(coord.getSnapshot(snap.runId)?.status).toBe('running')
  })
})

function relayTriggerOf(runId: string): SubagentRelayTrigger {
  return {
    version: 1,
    requestId: runId,
    receiveMessageId: `msg_relay_${runId}`,
    originUserMessageId: 'user-origin',
    anchorMessageId: null,
    items: [{ notificationId: 'ntf_x', sourceRunId: 'run_child', content: 'frozen' }],
    createdAt: 1
  }
}
