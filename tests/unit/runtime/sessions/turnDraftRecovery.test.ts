import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'
import { RunStore } from '../../../../src/runtime/run/RunStore'
import { RunCoordinator } from '../../../../src/runtime/run/RunCoordinator'
import { recoverSessionTurnDrafts, recoverInterruptedTurnDraftsOnStartup } from '../../../../src/runtime/sessions/turnDraftRecovery'
import { buildConversationContext } from '../../../../src/runtime/sessions/conversationContext'
import * as atomicFile from '../../../../src/runtime/storage/atomicFile'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'nova-draft-recovery-')) })
afterEach(() => { vi.restoreAllMocks(); resetSessionIndexHostForTests(); rmSync(root, { recursive: true, force: true }) })

function setup(skill = false) {
  const store = new SessionStore(root)
  const session = store.create(root)
  store.appendMessageFast(session.id, { id: 'user', role: 'user', content: skill ? '/build 继续建站' : '继续建站', timestamp: 1 })
  const runStore = new RunStore({ runsRoot: join(root, 'runs') })
  const coordinator = new RunCoordinator({ store: runStore })
  const run = coordinator.startRun({ kind: 'agent', sessionId: session.id, workspaceId: root })
  coordinator.markRunning(run.runId, 'assistant')
  coordinator.upsertTurnDraft(run.runId, { messageId: 'assistant', userDelivery: {
    userMessageId: 'user', modeInstruction: '执行', sessionPrefix: null,
    ...(skill ? { skillInput: { assistantPrelude: '冻结的建站技能', userContent: '按技能建站' } } : {})
  }, blocks: [
    { type: 'text', content: '已完成首页' },
    { type: 'tool', toolCallId: 'write', toolName: 'write', arguments: { path: 'index.html' }, status: 'success', result: '已写入' },
    { type: 'tool', toolCallId: 'task', toolName: 'task', arguments: {}, status: 'running' }
  ] })
  const reboot = () => { const next = new RunCoordinator({ store: runStore }); next.reconcileOnStartup(); return next }
  return { store, sessionId: session.id, coordinator, runId: run.runId, reboot }
}

describe('中断草稿归档', () => {
  it.each([false, true])('重启恢复正文与工具结果，技能=%s，重复恢复不重复归档', skill => {
    const { store, sessionId, runId, coordinator: original, reboot } = setup(skill)
    const snapshot = original.getSnapshot(runId)!
    if (snapshot.turnDraft?.userDelivery?.skillInput) {
      snapshot.turnDraft.userDelivery.skillInput.assistantPrelude = '外部修改不得污染权威草稿'
      expect(original.getSnapshot(runId)?.turnDraft?.userDelivery?.skillInput?.assistantPrelude).toBe('冻结的建站技能')
    }
    const coordinator = reboot()
    recoverSessionTurnDrafts(sessionId, store, coordinator)
    const restored = store.loadActivePath(sessionId)!
    expect(restored.messages.map(m => m.id)).toEqual(['user', 'assistant'])
    expect(restored.messages[1]).toMatchObject({ interrupted: true, blocks: [
      { type: 'text', content: '已完成首页' }, { type: 'tool', status: 'success', result: '已写入' },
      { type: 'tool', status: 'error', result: '工具执行被中断' }
    ] })
    const replay = buildConversationContext(restored, 'default')
    expect(JSON.stringify(replay)).toContain('已完成首页')
    if (skill) {
      expect(restored.messages[0].content).toBe('/build 继续建站')
      expect(replay.slice(0, 2)).toEqual([
        { role: 'assistant', content: '冻结的建站技能', inputPrelude: true, origin: { messageId: 'user', step: 0 } },
        { role: 'user', content: '按技能建站\n\n执行', origin: { messageId: 'user', step: 1 } }
      ])
    }
    expect(coordinator.getSnapshot(runId)?.turnDraft).toBeNull()
    const file = join(root, 'sessions', sessionId, 'messages.jsonl')
    const bytes = readFileSync(file, 'utf8')
    recoverSessionTurnDrafts(sessionId, store, reboot())
    expect(readFileSync(file, 'utf8')).toBe(bytes)
  })

  it('已有继续消息时补回原位置，保留后来消息并更新分页索引', () => {
    const { store, sessionId, reboot } = setup()
    store.appendMessageFast(sessionId, { id: 'followup', role: 'user', content: '从中断处继续', timestamp: 2 })
    store.appendMessageFast(sessionId, { id: 'answer', role: 'assistant', content: '后来的回答', timestamp: 3 })
    recoverSessionTurnDrafts(sessionId, store, reboot())
    expect(store.loadActivePath(sessionId)?.messages.map(m => m.id)).toEqual(['user', 'assistant', 'followup', 'answer'])
    expect(store.loadSessionPage(sessionId, { limit: 20 })?.messages.map(m => m.id)).toEqual(['user', 'assistant', 'followup', 'answer'])
  })

  it('归档失败后仍保留草稿，重新恢复成功后才清除', () => {
    const { store, sessionId, runId, reboot } = setup()
    const coordinator = reboot()
    const save = vi.spyOn(store, 'recoverAssistantMessage').mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => recoverSessionTurnDrafts(sessionId, store, coordinator)).toThrow('disk full')
    expect(coordinator.getSnapshot(runId)?.turnDraft?.blocks).toHaveLength(3)
    save.mockRestore()
    recoverSessionTurnDrafts(sessionId, store, coordinator)
    expect(store.loadActivePath(sessionId)?.messages).toHaveLength(2)
  })

  it('仍在执行的任务不被封存', () => {
    const { store, sessionId, coordinator, runId } = setup()
    recoverSessionTurnDrafts(sessionId, store, coordinator)
    expect(store.loadActivePath(sessionId)?.messages).toHaveLength(1)
    expect(coordinator.getSnapshot(runId)?.turnDraft?.blocks).toHaveLength(3)
  })

  it('补回中断记录不会切换或改写已经重生成的回答分支', () => {
    const { store, sessionId, reboot } = setup()
    store.appendMessageFast(sessionId, { id: 'regenerated', role: 'assistant', content: '重新生成的回答', timestamp: 2 })
    store.appendMessageFast(sessionId, { id: 'branch-followup', role: 'user', content: '追问新回答', timestamp: 3 })
    recoverSessionTurnDrafts(sessionId, store, reboot())
    expect(store.loadActivePath(sessionId)?.messages.map(m => m.id)).toEqual(['user', 'regenerated', 'branch-followup'])
    expect(store.load(sessionId)?.messages.find(m => m.id === 'assistant')?.parentId).toBe('user')
  })

  it('消息已落盘但元数据提交失败时，下次恢复修正叶子且不重复消息', () => {
    const { store, sessionId, runId, reboot } = setup()
    const coordinator = reboot()
    const write = atomicFile.atomicWriteFileSync
    const fault = vi.spyOn(atomicFile, 'atomicWriteFileSync').mockImplementation((file, content, encoding) => {
      if (file === join(root, 'sessions', sessionId, 'session.json')) throw new Error('metadata write failed')
      write(file, content, encoding)
    })
    expect(() => recoverSessionTurnDrafts(sessionId, store, coordinator)).toThrow('metadata write failed')
    expect(coordinator.getSnapshot(runId)?.turnDraft).not.toBeNull()
    fault.mockRestore()
    recoverSessionTurnDrafts(sessionId, store, reboot())
    expect(store.loadActivePath(sessionId)?.messages.map(m => m.id)).toEqual(['user', 'assistant'])
    expect(store.load(sessionId)?.messageCount).toBe(2)
  })

  it('对账后未打开会话也会写入中断回复，且可幂等', () => {
    const { store, sessionId, runId, reboot } = setup()
    const coordinator = reboot()
    recoverInterruptedTurnDraftsOnStartup(
      [{ sessionId, turnDraft: coordinator.getSnapshot(runId)?.turnDraft ?? null }],
      store,
      coordinator
    )
    const restored = store.loadActivePath(sessionId)!
    expect(restored.messages.map(m => m.id)).toEqual(['user', 'assistant'])
    expect(coordinator.getSnapshot(runId)?.turnDraft).toBeNull()
    const file = join(root, 'sessions', sessionId, 'messages.jsonl')
    const bytes = readFileSync(file, 'utf8')
    recoverInterruptedTurnDraftsOnStartup(
      [{ sessionId, turnDraft: { messageId: 'assistant', attemptId: 'default', blocks: [], finalized: false, updatedAt: 1 } }],
      store,
      coordinator
    )
    expect(readFileSync(file, 'utf8')).toBe(bytes)
  })

  it('启动归档捕获坏草稿，不阻断其它会话', () => {
    const store = new SessionStore(root)
    const good = store.create(root)
    const bad = store.create(root)
    store.appendMessageFast(good.id, { id: 'user-good', role: 'user', content: '好', timestamp: 1 })
    store.appendMessageFast(bad.id, { id: 'user-bad', role: 'user', content: '坏', timestamp: 1 })
    const runStore = new RunStore({ runsRoot: join(root, 'runs') })
    const coordinator = new RunCoordinator({ store: runStore })
    const goodRun = coordinator.startRun({ kind: 'agent', sessionId: good.id, workspaceId: root })
    coordinator.markRunning(goodRun.runId, 'assistant-good')
    coordinator.upsertTurnDraft(goodRun.runId, {
      messageId: 'assistant-good',
      userDelivery: { userMessageId: 'user-good', modeInstruction: '执行', sessionPrefix: null },
      blocks: [{ type: 'text', content: '已完成' }]
    })
    const badRun = coordinator.startRun({ kind: 'agent', sessionId: bad.id, workspaceId: root })
    coordinator.markRunning(badRun.runId, 'assistant-bad')
    coordinator.upsertTurnDraft(badRun.runId, {
      messageId: 'assistant-bad',
      blocks: [{ type: 'text', content: '缺坐标' }]
    })
    const next = new RunCoordinator({ store: runStore })
    const interrupted = next.reconcileOnStartup()
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args)
    })
    expect(() => recoverInterruptedTurnDraftsOnStartup(interrupted, store, next)).not.toThrow()
    spy.mockRestore()
    expect(store.loadActivePath(good.id)?.messages.map(m => m.id)).toEqual(['user-good', 'assistant-good'])
    expect(store.loadActivePath(bad.id)?.messages.map(m => m.id)).toEqual(['user-bad'])
    expect(next.getSnapshot(badRun.runId)?.turnDraft).not.toBeNull()
    expect(errors.length).toBeGreaterThan(0)
  })
})
