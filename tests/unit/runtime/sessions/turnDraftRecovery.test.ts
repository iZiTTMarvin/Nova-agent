import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { deriveChildSessionId, SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'
import { RunStore } from '../../../../src/runtime/run/RunStore'
import { RunCoordinator } from '../../../../src/runtime/run/RunCoordinator'
import { recoverSessionTurnDrafts, recoverInterruptedTurnDraftsOnStartup } from '../../../../src/runtime/sessions/turnDraftRecovery'
import { buildConversationContext } from '../../../../src/runtime/sessions/conversationContext'
import * as atomicFile from '../../../../src/runtime/storage/atomicFile'
import { settleSubagentToolCall } from '../../../../src/runtime/subagents/toolSettlement'
import { createSpawnIdentity } from '../../../../src/runtime/subagents/identity'
import type { SubagentSessionMetadata } from '../../../../src/shared/subagents/types'

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

  it('缺坐标草稿回退叶子用户消息归档，不阻断其它会话', () => {
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
    const warnings: unknown[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args)
    })
    expect(() => recoverInterruptedTurnDraftsOnStartup(interrupted, store, next)).not.toThrow()
    spy.mockRestore()
    expect(store.loadActivePath(good.id)?.messages.map(m => m.id)).toEqual(['user-good', 'assistant-good'])
    expect(store.loadActivePath(bad.id)?.messages.map(m => m.id)).toEqual(['user-bad', 'assistant-bad'])
    expect(next.getSnapshot(badRun.runId)?.turnDraft).toBeNull()
    expect(warnings).toHaveLength(0)
  })

  it('缺坐标且叶子非用户消息时丢弃孤儿草稿，会话保持可用', () => {
    const store = new SessionStore(root)
    const session = store.create(root)
    store.appendMessageFast(session.id, { id: 'user', role: 'user', content: '提问', timestamp: 1 })
    store.appendMessageFast(session.id, { id: 'answer', role: 'assistant', content: '已回答', timestamp: 2 })
    const runStore = new RunStore({ runsRoot: join(root, 'runs') })
    const coordinator = new RunCoordinator({ store: runStore })
    const run = coordinator.startRun({ kind: 'agent', sessionId: session.id, workspaceId: root })
    coordinator.markRunning(run.runId, 'orphan')
    coordinator.upsertTurnDraft(run.runId, {
      messageId: 'orphan',
      blocks: [{ type: 'text', content: '无法定位的草稿' }]
    })
    const next = new RunCoordinator({ store: runStore })
    next.reconcileOnStartup()
    const warnings: unknown[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args)
    })
    expect(() => recoverSessionTurnDrafts(session.id, store, next)).not.toThrow()
    spy.mockRestore()
    expect(store.loadActivePath(session.id)?.messages.map(m => m.id)).toEqual(['user', 'answer'])
    expect(next.getSnapshot(run.runId)?.turnDraft).toBeNull()
    expect(warnings.length).toBeGreaterThan(0)
  })
})

function makeSettle(store: SessionStore, coordinator: RunCoordinator) {
  return (input: Parameters<typeof settleSubagentToolCall>[1]) =>
    settleSubagentToolCall({ sessionStore: store, runCoordinator: coordinator }, input)
}

function makeSubagentMetadata(
  parentSessionId: string,
  parentRunId: string,
  identity: { spawnKey: string; spawnRunId: string }
): SubagentSessionMetadata {
  return {
    lineage: {
      parentSessionId,
      parentRunId,
      rootRunId: parentRunId,
      depth: 1,
      spawnKey: identity.spawnKey,
      spawnRunId: identity.spawnRunId,
      origin: { kind: 'task_tool', parentMessageId: 'assistant', parentToolCallId: 'task-1' }
    },
    profile: {
      profileId: 'test',
      name: 'test',
      description: 'test',
      systemPrompt: 'test',
      toolNames: [],
      permissionCeiling: 'read_only',
      maxToolRounds: 10,
      configHash: 'hash'
    }
  }
}

/** 按真实身份派生建立 child 会话与 run：childSessionId 由 spawnKey 哈希，child runId 即 spawnRunId。 */
function setupChild(
  store: SessionStore,
  coordinator: RunCoordinator,
  opts: {
    parentSessionId: string
    parentRunId: string
    childAssistantText: string
    status: 'completed' | 'interrupted'
    /** true 时 child 结果只存在于未归档草稿中，归档后才对父可见 */
    draftOnly?: boolean
  }
) {
  const identity = createSpawnIdentity({
    parentRunId: opts.parentRunId,
    invocation: { kind: 'task_tool', parentMessageId: 'assistant', parentToolCallId: 'task-1' }
  })
  const childSessionId = deriveChildSessionId(identity.spawnKey)
  const created = store.createChildIfAbsent({
    childSessionId,
    workspaceRoot: root,
    mode: 'default',
    permissionMode: 'full_access',
    task: opts.childAssistantText,
    subagent: makeSubagentMetadata(opts.parentSessionId, opts.parentRunId, identity),
    codeIndexEnabled: false
  })
  const childRun = coordinator.startRun({
    kind: 'agent',
    runId: identity.spawnRunId,
    sessionId: childSessionId,
    workspaceId: root
  })
  coordinator.markRunning(childRun.runId, 'child-assistant')
  if (opts.draftOnly) {
    coordinator.upsertTurnDraft(childRun.runId, {
      messageId: 'child-assistant',
      userDelivery: {
        userMessageId: created.session.messages[0].id,
        modeInstruction: '',
        sessionPrefix: null
      },
      blocks: [{ type: 'text', content: opts.childAssistantText }]
    })
  } else {
    store.appendMessageFast(childSessionId, {
      id: 'child-assistant',
      role: 'assistant',
      content: opts.childAssistantText,
      timestamp: 2
    })
  }
  coordinator.commitTerminal({
    runId: childRun.runId,
    status: opts.status,
    reason: opts.status === 'interrupted' ? '进程退出' : 'done'
  })
  return { identity, childSessionId, childRun }
}

/** 建立带一个 running task 块的父会话草稿。 */
function setupParentWithTaskDraft(store: SessionStore, coordinator: RunCoordinator) {
  const parent = store.create(root)
  store.appendMessageFast(parent.id, { id: 'user', role: 'user', content: '启动子代理', timestamp: 1 })
  const parentRun = coordinator.startRun({ kind: 'agent', sessionId: parent.id, workspaceId: root })
  coordinator.markRunning(parentRun.runId, 'assistant')
  coordinator.upsertTurnDraft(parentRun.runId, {
    messageId: 'assistant',
    userDelivery: { userMessageId: 'user', modeInstruction: '执行', sessionPrefix: null },
    blocks: [{ type: 'tool', toolCallId: 'task-1', toolName: 'task', arguments: {}, status: 'running' }]
  })
  return { parent, parentRun }
}

describe('结算端口注入后的草稿归档', () => {
  it('a) child 已完成时，running task 块结算为 success 并含精确摘要', () => {
    const store = new SessionStore(root)
    const runStore = new RunStore({ runsRoot: join(root, 'runs') })
    const coordinator = new RunCoordinator({ store: runStore })
    const { parent, parentRun } = setupParentWithTaskDraft(store, coordinator)
    const { childSessionId } = setupChild(store, coordinator, {
      parentSessionId: parent.id,
      parentRunId: parentRun.runId,
      childAssistantText: '子代理完成：首页已构建',
      status: 'completed'
    })

    const reboot = new RunCoordinator({ store: runStore })
    reboot.reconcileOnStartup()
    recoverSessionTurnDrafts(parent.id, store, reboot, makeSettle(store, coordinator))

    const msg = store.loadActivePath(parent.id)!.messages.find(m => m.id === 'assistant')!
    const taskBlock = msg.blocks!.find(b => b.type === 'tool' && b.toolCallId === 'task-1')
    expect(taskBlock).toMatchObject({ status: 'success' })
    const result = taskBlock && taskBlock.type === 'tool' ? taskBlock.result : ''
    expect(result).toContain('子代理')
    expect(result).toContain(childSessionId)
    expect(result).toContain('首页已构建')
    expect(reboot.getSnapshot(parentRun.runId)?.turnDraft).toBeNull()
  })

  it('b) child interrupted 时，running task 块结算为 error 并含 childSessionId/runId/继续入口', () => {
    const store = new SessionStore(root)
    const runStore = new RunStore({ runsRoot: join(root, 'runs') })
    const coordinator = new RunCoordinator({ store: runStore })
    const { parent, parentRun } = setupParentWithTaskDraft(store, coordinator)
    const { childSessionId, childRun } = setupChild(store, coordinator, {
      parentSessionId: parent.id,
      parentRunId: parentRun.runId,
      childAssistantText: '部分输出',
      status: 'interrupted'
    })

    const reboot = new RunCoordinator({ store: runStore })
    reboot.reconcileOnStartup()
    recoverSessionTurnDrafts(parent.id, store, reboot, makeSettle(store, coordinator))

    const msg = store.loadActivePath(parent.id)!.messages.find(m => m.id === 'assistant')!
    const taskBlock = msg.blocks!.find(b => b.type === 'tool' && b.toolCallId === 'task-1')
    expect(taskBlock).toMatchObject({ status: 'error' })
    const result = taskBlock && taskBlock.type === 'tool' ? String(taskBlock.result) : ''
    expect(result).toContain(childSessionId)
    expect(result).toContain(childRun.runId)
    expect(result).toContain('task_followup')
  })

  it('c) 非子代理工具(bash) running 块即使注入 settle 也回落通用文案', () => {
    const store = new SessionStore(root)
    const session = store.create(root)
    store.appendMessageFast(session.id, { id: 'user', role: 'user', content: '运行命令', timestamp: 1 })
    const runStore = new RunStore({ runsRoot: join(root, 'runs') })
    const coordinator = new RunCoordinator({ store: runStore })
    const run = coordinator.startRun({ kind: 'agent', sessionId: session.id, workspaceId: root })
    coordinator.markRunning(run.runId, 'assistant')
    coordinator.upsertTurnDraft(run.runId, {
      messageId: 'assistant',
      userDelivery: { userMessageId: 'user', modeInstruction: '执行', sessionPrefix: null },
      blocks: [{ type: 'tool', toolCallId: 'bash-1', toolName: 'bash', arguments: { command: 'ls' }, status: 'running' }]
    })

    const reboot = new RunCoordinator({ store: runStore })
    reboot.reconcileOnStartup()
    recoverSessionTurnDrafts(session.id, store, reboot, makeSettle(store, coordinator))

    const msg = store.loadActivePath(session.id)!.messages.find(m => m.id === 'assistant')!
    const bashBlock = msg.blocks!.find(b => b.type === 'tool' && b.toolCallId === 'bash-1')
    expect(bashBlock).toMatchObject({ status: 'error', result: '工具执行被中断' })
  })

  it('d) listRecoverableTurnDraftRuns 枚举跨重启的终态未归档草稿，不依赖本次对账返回数组', () => {
    const store = new SessionStore(root)
    const session = store.create(root)
    store.appendMessageFast(session.id, { id: 'user', role: 'user', content: 'test', timestamp: 1 })
    const runStore = new RunStore({ runsRoot: join(root, 'runs') })
    const c = new RunCoordinator({ store: runStore })

    // interrupted 终态 + 未归档草稿
    const recoverableRun = c.startRun({ kind: 'agent', sessionId: session.id, workspaceId: root })
    c.markRunning(recoverableRun.runId, 'b')
    c.upsertTurnDraft(recoverableRun.runId, {
      messageId: 'b',
      userDelivery: { userMessageId: 'user', modeInstruction: '执行', sessionPrefix: null },
      blocks: [{ type: 'tool', toolCallId: 't', toolName: 'task', arguments: {}, status: 'running' }]
    })
    c.commitTerminal({ runId: recoverableRun.runId, status: 'failed', reason: 'err' })

    // completed 终态 + 未归档草稿（正常完成也可能遗留）
    const completedRun = c.startRun({ kind: 'agent', sessionId: session.id, workspaceId: root })
    c.markRunning(completedRun.runId, 'c')
    c.upsertTurnDraft(completedRun.runId, {
      messageId: 'c',
      userDelivery: { userMessageId: 'user', modeInstruction: '执行', sessionPrefix: null },
      blocks: []
    })
    c.commitTerminal({ runId: completedRun.runId, status: 'completed', reason: 'done' })

    // 第一次重启：对账但不归档
    const reboot1 = new RunCoordinator({ store: runStore })
    reboot1.reconcileOnStartup()
    // 第二次重启：枚举仍应列出两个 run（证明不依赖本次 interrupted 返回数组）
    const reboot2 = new RunCoordinator({ store: runStore })
    reboot2.reconcileOnStartup()
    const recoverable = reboot2.listRecoverableTurnDraftRuns()
    expect(recoverable.map(s => s.runId).sort()).toEqual([completedRun.runId, recoverableRun.runId].sort())

    // finalized=true 的被过滤
    recoverSessionTurnDrafts(session.id, store, reboot2)
    expect(reboot2.listRecoverableTurnDraftRuns()).toHaveLength(0)
  })

  it('e) 子在父前：child 草稿先归档后，parent 的 task 块读到 child 精确结果', () => {
    const store = new SessionStore(root)
    const runStore = new RunStore({ runsRoot: join(root, 'runs') })
    const coordinator = new RunCoordinator({ store: runStore })
    const { parent, parentRun } = setupParentWithTaskDraft(store, coordinator)
    // child 结果只存在于未归档草稿中：只有 child 先归档，parent 结算才能读到
    const { childSessionId } = setupChild(store, coordinator, {
      parentSessionId: parent.id,
      parentRunId: parentRun.runId,
      childAssistantText: '子代理完成',
      status: 'completed',
      draftOnly: true
    })
    expect(store.loadActivePath(childSessionId)!.messages.some(m => m.id === 'child-assistant')).toBe(false)

    const reboot = new RunCoordinator({ store: runStore })
    reboot.reconcileOnStartup()
    recoverInterruptedTurnDraftsOnStartup(
      reboot.listRecoverableTurnDraftRuns(),
      store,
      reboot,
      makeSettle(store, coordinator)
    )

    // child 草稿先被归档：结果消息进入 child 会话
    expect(store.loadActivePath(childSessionId)!.messages.some(m => m.id === 'child-assistant')).toBe(true)
    // parent 的 task 块读到 child 已归档的精确结果
    const msg = store.loadActivePath(parent.id)!.messages.find(m => m.id === 'assistant')!
    const taskBlock = msg.blocks!.find(b => b.type === 'tool' && b.toolCallId === 'task-1')
    expect(taskBlock).toMatchObject({ status: 'success' })
    const result = taskBlock && taskBlock.type === 'tool' ? String(taskBlock.result) : ''
    expect(result).toContain(childSessionId)
    expect(result).toContain('子代理完成')
  })

  it('e2) child 归档失败被隔离，parent 仍归档且 task 块按结果不可读精确降级', () => {
    const store = new SessionStore(root)
    const runStore = new RunStore({ runsRoot: join(root, 'runs') })
    const coordinator = new RunCoordinator({ store: runStore })
    const { parent, parentRun } = setupParentWithTaskDraft(store, coordinator)
    const { childSessionId } = setupChild(store, coordinator, {
      parentSessionId: parent.id,
      parentRunId: parentRun.runId,
      childAssistantText: '子代理完成',
      status: 'completed',
      draftOnly: true
    })

    // child 会话归档注入持久失败；parent 走同一 store 不受影响
    const originalRecover = store.recoverAssistantMessage.bind(store)
    vi.spyOn(store, 'recoverAssistantMessage').mockImplementation(
      (...args: Parameters<SessionStore['recoverAssistantMessage']>) => {
        if (args[0] === childSessionId) throw new Error('disk full')
        return originalRecover(...args)
      }
    )

    const reboot = new RunCoordinator({ store: runStore })
    reboot.reconcileOnStartup()
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
    expect(() =>
      recoverInterruptedTurnDraftsOnStartup(
        reboot.listRecoverableTurnDraftRuns(),
        store,
        reboot,
        makeSettle(store, coordinator)
      )
    ).not.toThrow()
    spy.mockRestore()
    expect(errors.length).toBeGreaterThan(0)

    // child 草稿保留未归档
    expect(store.loadActivePath(childSessionId)!.messages.some(m => m.id === 'child-assistant')).toBe(false)
    // parent 已归档，task 块按"结果消息不可读"精确降级，不伪造成功
    const msg = store.loadActivePath(parent.id)!.messages.find(m => m.id === 'assistant')!
    const taskBlock = msg.blocks!.find(b => b.type === 'tool' && b.toolCallId === 'task-1')
    expect(taskBlock).toMatchObject({ status: 'error' })
    const result = taskBlock && taskBlock.type === 'tool' ? String(taskBlock.result) : ''
    expect(result).toContain('不可读')
    expect(result).toContain(childSessionId)
  })
})
