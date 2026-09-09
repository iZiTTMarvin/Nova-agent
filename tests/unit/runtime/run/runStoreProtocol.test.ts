/**
 * RunStore 统一落盘协议：event→fsync→snapshot；尾部重放；非法 runId
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRunCoordinator, RunStore, assertSafeRunId } from '../../../../src/runtime/run'

describe('RunStore 落盘协议与 sequence', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-runstore-'))
  })

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('非法 runId 拒绝访问 runsRoot 外部', () => {
    expect(() => assertSafeRunId('../escape')).toThrow()
    expect(() => assertSafeRunId('a/b')).toThrow()
    expect(() => assertSafeRunId('C:\\abs')).toThrow()
    const store = new RunStore({ runsRoot: tmp })
    expect(() => store.loadSnapshot('..')).toThrow()
  })

  it('clearTurnDraft 后重启 sequence 仍单调', () => {
    const coord = createRunCoordinator(tmp)
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: 'ws',
      sessionId: 's1',
      runId: 'run_seq1'
    })
    coord.markRunning(snap.runId, 'msg1')
    coord.upsertTurnDraft(snap.runId, {
      messageId: 'msg1',
      blocks: [{ type: 'text', content: 'hi' }]
    })
    const beforeClear = coord.getSnapshot(snap.runId)!.sequence
    coord.commitTerminal({ runId: snap.runId, status: 'completed' })
    coord.clearTurnDraft(snap.runId)
    const afterClear = coord.getSnapshot(snap.runId)!.sequence
    expect(afterClear).toBeGreaterThan(beforeClear)

    // 模拟重启：新 coordinator 从磁盘加载
    const coord2 = createRunCoordinator(tmp)
    const reloaded = coord2.getSnapshot('run_seq1')
    expect(reloaded).not.toBeNull()
    expect(reloaded!.sequence).toBe(afterClear)
    expect(reloaded!.turnDraft == null || reloaded!.turnDraft === null).toBe(true)
  })

  it('interrupted → resuming sequence 单调递增，不产生重复', () => {
    const coord = createRunCoordinator(tmp)
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: 'ws',
      sessionId: 's1',
      runId: 'run_resume1'
    })
    coord.markRunning(snap.runId)
    coord.commitTerminal({ runId: snap.runId, status: 'interrupted', reason: 'test' })
    const seq1 = coord.getSnapshot(snap.runId)!.sequence
    const next = coord.transition(snap.runId, 'resuming', 'user_continue')
    expect(next).not.toBeNull()
    expect(next!.status).toBe('resuming')
    expect(next!.sequence).toBeGreaterThan(seq1)
  })

  it('snapshot 落后 event 时能重放恢复', () => {
    const store = new RunStore({ runsRoot: tmp })
    const runId = 'run_replay1'
    // 先写一条完整事务
    store.commitTransaction(
      {
        runId,
        kind: 'agent',
        workspaceId: 'ws',
        sessionId: 's1',
        messageId: '',
        status: 'running',
        sequence: 1,
        pendingInteractions: [],
        currentAttempt: null,
        progress: null,
        lastHeartbeatAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      'run_started'
    )
    // 再追加一条领先的 event（模拟 snapshot 未写完就崩溃）
    const eventsPath = join(tmp, runId, 'events.jsonl')
    appendFileSync(
      eventsPath,
      JSON.stringify({
        sequence: 2,
        runId,
        type: 'terminal',
        at: Date.now(),
        payload: { status: 'interrupted', reason: 'crash' }
      }) + '\n',
      'utf8'
    )
    // snapshot 仍停在 sequence=1
    const snapPath = join(tmp, runId, 'snapshot.json')
    expect(JSON.parse(readFileSync(snapPath, 'utf8')).sequence).toBe(1)

    const replayed = store.loadSnapshotWithReplay(runId)!
    expect(replayed.sequence).toBe(2)
    expect(replayed.status).toBe('interrupted')
  })

  it('terminal 事件领先时从 payload 重建 incompleteReason，未知字符串拒绝', () => {
    const store = new RunStore({ runsRoot: tmp })
    const runId = 'run_replay2'
    store.commitTransaction(
      {
        runId,
        kind: 'agent',
        workspaceId: 'ws',
        sessionId: 's1',
        messageId: '',
        status: 'running',
        sequence: 1,
        pendingInteractions: [],
        currentAttempt: null,
        progress: null,
        lastHeartbeatAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      'run_started'
    )
    const eventsPath = join(tmp, runId, 'events.jsonl')
    appendFileSync(
      eventsPath,
      JSON.stringify({
        sequence: 2,
        runId,
        type: 'terminal',
        at: Date.now(),
        payload: {
          status: 'completed',
          incompleteReason: 'max_rounds'
        }
      }) + '\n',
      'utf8'
    )

    const replayed = store.loadSnapshotWithReplay(runId)!
    expect(replayed.status).toBe('completed')
    expect(replayed.incompleteReason).toBe('max_rounds')

    // 未知字符串不得冒充截断原因
    appendFileSync(
      eventsPath,
      JSON.stringify({
        sequence: 3,
        runId,
        type: 'terminal',
        at: Date.now(),
        payload: {
          status: 'completed',
          incompleteReason: 'arbitrary-string'
        }
      }) + '\n',
      'utf8'
    )
    const replayedAgain = store.loadSnapshotWithReplay(runId)!
    expect(replayedAgain.incompleteReason).toBe('max_rounds')
  })

  it('saveSnapshot 直接调用被禁用', () => {
    const store = new RunStore({ runsRoot: tmp })
    expect(() =>
      store.saveSnapshot({
        runId: 'x',
        kind: 'agent',
        workspaceId: 'w',
        sessionId: 's',
        messageId: '',
        status: 'queued',
        sequence: 0,
        pendingInteractions: [],
        currentAttempt: null,
        progress: null,
        lastHeartbeatAt: 0,
        createdAt: 0,
        updatedAt: 0
      })
    ).toThrow(/commitTransaction/)
  })

  it('commandAck 走统一 commit，sequence 递增', () => {
    const coord = createRunCoordinator(tmp)
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: 'ws',
      sessionId: 's1',
      runId: 'run_ack1'
    })
    const seq0 = coord.getSnapshot(snap.runId)!.sequence
    coord.rememberCommandAck(snap.runId, {
      commandId: 'cmd1',
      interactionId: 'i1',
      at: Date.now(),
      ok: true
    })
    const after = coord.getSnapshot(snap.runId)!
    expect(after.sequence).toBeGreaterThan(seq0)
    expect(after.commandAcks?.some(a => a.commandId === 'cmd1')).toBe(true)
  })

  it('批量事务一次写入多行事件并只写一次快照，重放形状不变', () => {
    const store = new RunStore({ runsRoot: tmp })
    const base = {
      runId: 'run_batch1',
      kind: 'agent' as const,
      workspaceId: 'ws',
      sessionId: 's1',
      messageId: '',
      status: 'running' as const,
      sequence: 1,
      pendingInteractions: [],
      currentAttempt: null,
      progress: null,
      lastHeartbeatAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    store.commitTransaction({ ...base }, 'run_started')
    expect(store.commitTransactionBatch({ ...base, sequence: 1 }, [])).toEqual([])

    const records = store.commitTransactionBatch(
      { ...base, sequence: 3, status: 'running' },
      [
        { type: 'heartbeat', sequence: 2, payload: { label: '调用 read' } },
        { type: 'tool_phase', sequence: 3, payload: { phase: 'prepared' } }
      ]
    )
    expect(records.map(event => event.sequence)).toEqual([2, 3])
    const { events } = store.loadEvents('run_batch1')
    expect(events.map(event => event.type)).toEqual(['run_started', 'heartbeat', 'tool_phase'])
    expect(JSON.parse(readFileSync(join(tmp, 'run_batch1', 'snapshot.json'), 'utf8')).sequence).toBe(3)

    expect(() =>
      store.commitTransactionBatch({ ...base, sequence: 6 }, [
        { type: 'heartbeat', sequence: 4 },
        { type: 'tool_phase', sequence: 6 }
      ])
    ).toThrow(/连续/)

    const replayed = store.loadSnapshotWithReplay('run_batch1')
    expect(replayed?.sequence).toBe(3)
    expect(replayed?.status).toBe('running')
  })
})

describe('terminal outbox 崩溃恢复', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-outbox-'))
  })

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('handler 抛错不会标 delivered；晚注册后 drain pending', async () => {
    const coord = createRunCoordinator(tmp)
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: 'ws',
      sessionId: 's1',
      runId: 'run_ob1'
    })
    coord.markRunning(snap.runId)

    let calls = 0
    const unsub = coord.onTerminalHook('onComplete', () => {
      calls += 1
      if (calls === 1) throw new Error('hook fail')
    })

    coord.commitTerminal({ runId: snap.runId, status: 'completed' })
    // 等异步 hook
    await new Promise(r => setTimeout(r, 50))
    const mid = coord.getSnapshot(snap.runId)!
    const entry = mid.terminalOutbox?.find(e => e.hookName === 'onComplete')
    expect(entry?.status).toBe('failed')
    expect(entry?.status).not.toBe('delivered')

    // 再次 drain：第二次成功
    await coord.drainPendingOutbox(snap.runId)
    const after = coord.getSnapshot(snap.runId)!
    expect(after.terminalOutbox?.find(e => e.hookName === 'onComplete')?.status).toBe('delivered')
    expect(calls).toBe(2)
    unsub()
  })

  it('无 handler 时保持 pending，不标 delivered', async () => {
    const coord = createRunCoordinator(tmp)
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: 'ws',
      sessionId: 's1',
      runId: 'run_ob2'
    })
    coord.markRunning(snap.runId)
    // 不注册任何 handler
    coord.commitTerminal({ runId: snap.runId, status: 'failed', reason: 'x' })
    await new Promise(r => setTimeout(r, 30))
    const after = coord.getSnapshot(snap.runId)!
    const entry = after.terminalOutbox?.find(e => e.hookName === 'onFail')
    expect(entry?.status).toBe('pending')
  })

  it('大量已结束任务时，扫描未结束任务只重放那一个', () => {
    const coord = createRunCoordinator(tmp)
    for (let i = 0; i < 40; i++) {
      const snap = coord.startRun({
        kind: 'agent',
        workspaceId: 'ws',
        sessionId: `s${i}`,
        runId: `run_done_${i}`
      })
      coord.markRunning(snap.runId)
      coord.commitTerminal({ runId: snap.runId, status: 'completed' })
    }
    const live = coord.startRun({
      kind: 'agent',
      workspaceId: 'ws',
      sessionId: 'live',
      runId: 'run_live'
    })
    coord.markRunning(live.runId)

    const store = new RunStore({ runsRoot: tmp })
    const loadEvents = vi.spyOn(store, 'loadEvents')
    const listed = store.listNonTerminalSnapshots()
    expect(listed.map(snap => snap.runId)).toEqual(['run_live'])
    expect(loadEvents.mock.calls.map(call => call[0])).toEqual(['run_live'])

    loadEvents.mockClear()
    const found = store.findSnapshotsBySessions(new Set(['live', 's0']))
    expect(found.map(snap => snap.runId).sort()).toEqual(['run_done_0', 'run_live'])
    expect(loadEvents.mock.calls.map(call => call[0])).toEqual(['run_live'])
  })
})
