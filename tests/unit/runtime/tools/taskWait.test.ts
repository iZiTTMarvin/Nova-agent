import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { RunCoordinator, RunStore } from '../../../../src/runtime/run'
import { SessionStore, deriveChildSessionId } from '../../../../src/runtime/sessions/SessionStore'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { createTaskWaitTool, type TaskWaitResult, type TaskWaitToolDeps } from '../../../../src/runtime/tools/task_wait'
import type { ToolContext, ToolInvocationRef } from '../../../../src/runtime/tools/types'

let root: string

beforeEach(() => {
  resetSessionIndexHostForTests()
  root = mkdtempSync(join(tmpdir(), 'nova-task-wait-'))
})

afterEach(() => {
  resetSessionIndexHostForTests()
  rmSync(root, { recursive: true, force: true })
})

interface ChildSetup {
  readonly childSessionId: string
  readonly runId: string
}

function setupChild(
  store: SessionStore,
  coordinator: RunCoordinator,
  parentSessionId: string,
  parentRunId: string,
  spawnKey: string,
  options: { readonly execution?: 'sync' | 'background_read_only' } = {}
): ChildSetup {
  const execution = options.execution ?? 'background_read_only'
  const childSessionId = deriveChildSessionId(spawnKey)
  const runId = `run-${spawnKey}`
  store.createChildIfAbsent({
    childSessionId,
    workspaceRoot: resolve(root, 'workspace'),
    mode: 'default',
    permissionMode: 'request_approval',
    task: `task ${spawnKey}`,
    subagent: {
      lineage: {
        parentSessionId,
        parentRunId,
        rootRunId: parentRunId,
        depth: 1,
        spawnKey,
        spawnRunId: '11111111-2222-3333-4444-555555555555',
        origin: {
          kind: 'task_tool',
          parentMessageId: `msg-parent-${spawnKey}`,
          parentToolCallId: `call-task-${spawnKey}`
        }
      },
      profile: {
        profileId: 'explore',
        name: 'explore',
        description: 'read only',
        systemPrompt: 'inspect evidence',
        toolNames: ['read', 'grep'],
        permissionCeiling: 'read_only',
        maxToolRounds: 20,
        configHash: 'a'.repeat(64)
      }
    }
  })
  coordinator.startRun({
    kind: 'agent',
    runId,
    workspaceId: root,
    sessionId: childSessionId,
    dispatch: {
      version: 1,
      callKind: 'task',
      parentSessionId,
      parentRunId,
      parentMessageId: `msg-parent-${spawnKey}`,
      execution,
      topParentSessionId: parentSessionId,
      originUserMessageId: `user-${spawnKey}`
    }
  })
  coordinator.markRunning(runId, `msg-child-${spawnKey}`)
  return { childSessionId, runId }
}

function makeDeps(coordinator: RunCoordinator): TaskWaitToolDeps {
  return { getRunCoordinator: () => coordinator }
}

function makeInvocationRef(sessionId: string, runId: string): ToolInvocationRef {
  return { sessionId, runId, messageId: 'msg-invocation', toolCallId: 'call-invocation' }
}

function makeContext(
  store: SessionStore,
  sessionId: string,
  runId: string,
  abortSignal?: AbortSignal
): ToolContext {
  return {
    workingDir: resolve(root, 'workspace'),
    readState: createReadState(),
    sessionStore: store,
    sessionId,
    runId,
    invocationRef: makeInvocationRef(sessionId, runId),
    ...(abortSignal ? { abortSignal } : {})
  }
}

function parseResult(output: string): TaskWaitResult {
  return JSON.parse(output) as TaskWaitResult
}

describe('task_wait 参数与边界', () => {
  it('run_ids 与 all_unfinished 必须二选一，缺失或同时指定都失败', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const tool = createTaskWaitTool(makeDeps(coordinator))

    const noArgs = await tool.execute({}, makeContext(store, parent.id, parentRun.runId))
    expect(noArgs.success).toBe(false)

    const both = await tool.execute(
      { run_ids: ['x'], all_unfinished: true },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(both.success).toBe(false)

    const emptyRunIds = await tool.execute(
      { run_ids: [] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(emptyRunIds.success).toBe(false)

    const allFalse = await tool.execute(
      { all_unfinished: false },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(allFalse.success).toBe(false)
  })

  it('run_ids 非字符串数组或元素 trim 后为空都失败', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const tool = createTaskWaitTool(makeDeps(coordinator))

    const stringNotArray = await tool.execute(
      { run_ids: 'x' },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(stringNotArray.success).toBe(false)
    expect(stringNotArray.error).toContain('run_ids')

    const blankElement = await tool.execute(
      { run_ids: ['  '] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(blankElement.success).toBe(false)
    expect(blankElement.error).toContain('run_ids')
  })

  it('缺少 sessionStore/sessionId/runId/invocationRef 时失败', async () => {
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const tool = createTaskWaitTool(makeDeps(coordinator))
    const result = await tool.execute({ all_unfinished: true }, {
      workingDir: root,
      readState: createReadState()
    } as ToolContext)
    expect(result.success).toBe(false)
    expect(result.error).toContain('invocationRef')
  })

  it('invocationRef 与 context 不一致时失败', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const tool = createTaskWaitTool(makeDeps(coordinator))

    const mismatched = await tool.execute(
      { all_unfinished: true },
      {
        workingDir: resolve(root, 'workspace'),
        readState: createReadState(),
        sessionStore: store,
        sessionId: parent.id,
        runId: parentRun.runId,
        invocationRef: {
          sessionId: 'other-session',
          runId: parentRun.runId,
          messageId: 'msg',
          toolCallId: 'call'
        }
      }
    )
    expect(mismatched.success).toBe(false)
    expect(mismatched.error).toContain('不一致')
  })

  it('timeout_ms 非整数或超范围失败；0 表示立即复查返回', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-1')
    const tool = createTaskWaitTool(makeDeps(coordinator))

    // 非整数失败
    const nonInteger = await tool.execute(
      { run_ids: [child.runId], timeout_ms: 1.5 },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(nonInteger.success).toBe(false)
    expect(nonInteger.error).toContain('timeout_ms')

    // 超范围失败
    const overMax = await tool.execute(
      { run_ids: [child.runId], timeout_ms: 60_001 },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(overMax.success).toBe(false)
    expect(overMax.error).toContain('timeout_ms')

    // 负数失败
    const negative = await tool.execute(
      { run_ids: [child.runId], timeout_ms: -1 },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(negative.success).toBe(false)
    expect(negative.error).toContain('timeout_ms')

    // timeout_ms=0 立即返回 timeout（子代理未终态）
    const immediate = await tool.execute(
      { run_ids: [child.runId], timeout_ms: 0 },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(immediate.success).toBe(true)
    const payload = parseResult(immediate.output)
    expect(payload.reason).toBe('timeout')
    expect(payload.targets).toHaveLength(1)
    expect(payload.targets[0].runId).toBe(child.runId)
    expect(payload.targets[0].status).toBe('running')
  })
})

describe('task_wait 越权与归属校验', () => {
  it('等待自身 run 失败', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const tool = createTaskWaitTool(makeDeps(coordinator))

    const result = await tool.execute(
      { run_ids: [parentRun.runId] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('自身')
  })

  it('等待祖先 run 失败', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-1')
    const grandchildSessionId = deriveChildSessionId('grandchild')
    const grandchildRunId = 'run-grandchild'
    store.createChildIfAbsent({
      childSessionId: grandchildSessionId,
      workspaceRoot: resolve(root, 'workspace'),
      mode: 'default',
      permissionMode: 'request_approval',
      task: 'grandchild task',
      subagent: {
        lineage: {
          parentSessionId: child.childSessionId,
          parentRunId: child.runId,
          rootRunId: parentRun.runId,
          depth: 2,
          spawnKey: 'grandchild',
          spawnRunId: '22222222-3333-4444-5555-666666666666',
          origin: {
            kind: 'task_tool',
            parentMessageId: 'msg-child-child-1',
            parentToolCallId: 'call-grandchild'
          }
        },
        profile: {
          profileId: 'explore',
          name: 'explore',
          description: 'read only',
          systemPrompt: 'inspect evidence',
          toolNames: ['read', 'grep'],
          permissionCeiling: 'read_only',
          maxToolRounds: 20,
          configHash: 'a'.repeat(64)
        }
      }
    })
    coordinator.startRun({
      kind: 'agent',
      runId: grandchildRunId,
      workspaceId: root,
      sessionId: grandchildSessionId,
      dispatch: {
        version: 1,
        callKind: 'task',
        parentSessionId: child.childSessionId,
        parentRunId: child.runId,
        parentMessageId: 'msg-child-child-1',
        execution: 'background_read_only',
        topParentSessionId: parent.id,
        originUserMessageId: 'user-grandchild'
      }
    })
    coordinator.markRunning(grandchildRunId, 'msg-grandchild')
    const tool = createTaskWaitTool(makeDeps(coordinator))

    const result = await tool.execute(
      { run_ids: [parentRun.runId] },
      makeContext(store, grandchildSessionId, grandchildRunId)
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('祖先')
  })

  it('等待不属于当前会话树的 run 失败，且整体失败关闭', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parentA = store.create(resolve(root, 'workspace'))
    const parentB = store.create(resolve(root, 'workspace'))
    const runA = coordinator.startRun({
      kind: 'agent', runId: 'run-a', workspaceId: root, sessionId: parentA.id
    })
    coordinator.markRunning(runA.runId, 'msg-a')
    const runB = coordinator.startRun({
      kind: 'agent', runId: 'run-b', workspaceId: root, sessionId: parentB.id
    })
    coordinator.markRunning(runB.runId, 'msg-b')
    const childA = setupChild(store, coordinator, parentA.id, runA.runId, 'child-a')
    const childB = setupChild(store, coordinator, parentB.id, runB.runId, 'child-b')
    const tool = createTaskWaitTool(makeDeps(coordinator))

    const foreign = await tool.execute(
      { run_ids: [childB.runId] },
      makeContext(store, parentA.id, runA.runId)
    )
    expect(foreign.success).toBe(false)
    expect(foreign.error).toContain('不属于当前会话派生')

    const mixed = await tool.execute(
      { run_ids: [childA.runId, childB.runId] },
      makeContext(store, parentA.id, runA.runId)
    )
    expect(mixed.success).toBe(false)
    expect(mixed.error).toContain('不属于当前会话派生')
  })

  it('等待不存在的 run 失败', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const tool = createTaskWaitTool(makeDeps(coordinator))

    const result = await tool.execute(
      { run_ids: ['nonexistent-run'] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('不存在')
  })
})

describe('task_wait all_unfinished 与空集合', () => {
  it('all_unfinished 无可等待任务时立即成功返回 empty', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const tool = createTaskWaitTool(makeDeps(coordinator))

    const result = await tool.execute(
      { all_unfinished: true, timeout_ms: 0 },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(true)
    const payload = parseResult(result.output)
    expect(payload.ok).toBe(true)
    expect(payload.reason).toBe('empty')
    expect(payload.targets).toEqual([])
  })

  it('all_unfinished 只选择 background_read_only 且未终态的 run；sync 与终态被排除', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')

    const bg = setupChild(store, coordinator, parent.id, parentRun.runId, 'bg')
    const bgDone = setupChild(store, coordinator, parent.id, parentRun.runId, 'bg-done')
    coordinator.commitTerminal({ runId: bgDone.runId, status: 'completed' })
    const sync = setupChild(store, coordinator, parent.id, parentRun.runId, 'sync', { execution: 'sync' })

    const tool = createTaskWaitTool(makeDeps(coordinator))
    const result = await tool.execute(
      { all_unfinished: true, timeout_ms: 0 },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(true)
    const payload = parseResult(result.output)
    expect(payload.reason).toBe('timeout')
    const runIds = payload.targets.map(t => t.runId)
    expect(runIds).toContain(bg.runId)
    expect(runIds).not.toContain(bgDone.runId)
    expect(runIds).not.toContain(sync.runId)
  })
})

describe('task_wait 就绪与终态立即返回', () => {
  it('已有终态目标立即返回 ready，附带摘要与 notificationId', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-1')
    store.appendMessageFast(child.childSessionId, {
      id: 'msg-child-child-1',
      role: 'assistant',
      content: '子代理完成探索',
      timestamp: 2
    })
    coordinator.commitTerminal({
      runId: child.runId,
      status: 'completed',
      terminalTransitionId: 'terminal-1'
    })

    const tool = createTaskWaitTool(makeDeps(coordinator))
    const result = await tool.execute(
      { run_ids: [child.runId] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(true)
    const payload = parseResult(result.output)
    expect(payload.ok).toBe(true)
    expect(payload.reason).toBe('ready')
    expect(payload.targets).toHaveLength(1)
    const target = payload.targets[0]
    expect(target.runId).toBe(child.runId)
    expect(target.status).toBe('completed')
    expect(target.waitingUser).toBe(false)
    expect(target.notificationId).toContain(child.runId)
    expect(target.summary).toContain('子代理完成探索')
  })

  it('sync 终态不生成 notificationId', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-sync', {
      execution: 'sync'
    })
    coordinator.commitTerminal({
      runId: child.runId,
      status: 'completed',
      terminalTransitionId: 'terminal-sync'
    })

    const tool = createTaskWaitTool(makeDeps(coordinator))
    const result = await tool.execute(
      { run_ids: [child.runId] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(true)
    const target = parseResult(result.output).targets[0]
    expect(target.notificationId).toBeUndefined()
  })

  it('interrupted 终态不生成 notificationId', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-interrupted')
    coordinator.commitTerminal({
      runId: child.runId,
      status: 'interrupted',
      terminalTransitionId: 'terminal-interrupted'
    })

    const tool = createTaskWaitTool(makeDeps(coordinator))
    const result = await tool.execute(
      { run_ids: [child.runId] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(true)
    const target = parseResult(result.output).targets[0]
    expect(target.status).toBe('interrupted')
    expect(target.notificationId).toBeUndefined()
  })

  it('invalidated 终态不生成 notificationId', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-invalidated')
    coordinator.commitTerminal({
      runId: child.runId,
      status: 'completed',
      terminalTransitionId: 'terminal-invalidated'
    })
    coordinator.updateDeliveryBinding(child.runId, { invalidatedReason: 'branch_invalidate:op' })

    const tool = createTaskWaitTool(makeDeps(coordinator))
    const result = await tool.execute(
      { run_ids: [child.runId] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(true)
    const target = parseResult(result.output).targets[0]
    expect(target.notificationId).toBeUndefined()
  })

  it('waiting_user 目标立即返回 ready 且 waitingUser=true', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-1')
    coordinator.markWaitingUser(child.runId, '等待用户确认')

    const tool = createTaskWaitTool(makeDeps(coordinator))
    const result = await tool.execute(
      { run_ids: [child.runId] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(true)
    const payload = parseResult(result.output)
    expect(payload.reason).toBe('ready')
    expect(payload.targets[0].status).toBe('waiting_user')
    expect(payload.targets[0].waitingUser).toBe(true)
  })

  it('恢复不一致：status=running + pending interaction 投影为 waiting_user 并 ready', async () => {
    const store = new SessionStore(root)
    const runStore = new RunStore({ runsRoot: join(root, 'runs') })
    const coordinator = new RunCoordinator({ store: runStore })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-1')

    // 直接通过 RunStore 公开 API 持久化一个 status=running + pending interaction 的不一致快照，
    // 模拟崩溃前 addInteraction 已写盘但 status 未同步到 waiting_user 的恢复场景。
    const snap = coordinator.getSnapshot(child.runId)!
    const recovered: typeof snap = {
      ...snap,
      sequence: snap.sequence + 1,
      status: 'running',
      pendingInteractions: [
        {
          interactionId: 'inter-1',
          runId: child.runId,
          sessionId: child.childSessionId,
          messageId: 'msg-child-child-1',
          type: 'permission',
          status: 'pending',
          createdAt: Date.now(),
          version: 1,
          payload: {}
        }
      ]
    }
    runStore.commitTransaction(recovered, 'interaction_injected', { interactionId: 'inter-1' })

    // 新 coordinator 从磁盘加载，看到 status=running + pending interaction
    const recoveredCoord = new RunCoordinator({ store: runStore })
    const tool = createTaskWaitTool(makeDeps(recoveredCoord))

    const result = await tool.execute(
      { run_ids: [child.runId] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(true)
    const target = parseResult(result.output).targets[0]
    // 投影层把 pending interaction 视为 waitingUser，对外统一报 waiting_user
    expect(target.waitingUser).toBe(true)
    expect(target.status).toBe('waiting_user')
    expect(parseResult(result.output).reason).toBe('ready')
  })
})

describe('task_wait 订阅与竞态', () => {
  it('先订阅再复查：subscribe 建立后 commit terminal 能唤醒并返回 ready', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-1')
    const tool = createTaskWaitTool(makeDeps(coordinator))

    // 用 deferred Promise 确认 task_wait 已建立订阅后再 commit terminal
    let resolveSubscribed: () => void
    const subscribed = new Promise<void>(resolve => { resolveSubscribed = resolve })
    const originalSubscribe = coordinator.subscribe.bind(coordinator)
    coordinator.subscribe = (listener) => {
      resolveSubscribed()
      return originalSubscribe(listener)
    }

    const waitPromise = tool.execute(
      { run_ids: [child.runId], timeout_ms: 5_000 },
      makeContext(store, parent.id, parentRun.runId)
    )
    // 等 subscribe 被调用（确认订阅已建立），再 commit terminal
    await subscribed
    store.appendMessageFast(child.childSessionId, {
      id: 'msg-child-child-1',
      role: 'assistant',
      content: '完成',
      timestamp: 2
    })
    coordinator.commitTerminal({
      runId: child.runId,
      status: 'completed',
      terminalTransitionId: 'terminal-1'
    })

    const result = await waitPromise
    expect(result.success).toBe(true)
    expect(parseResult(result.output).reason).toBe('ready')
    expect(parseResult(result.output).targets[0].status).toBe('completed')
  })

  it('subscribe 前 recheck 已就绪则立即返回，不进入等待', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-1')
    coordinator.commitTerminal({ runId: child.runId, status: 'cancelled' })

    let subscribed = false
    coordinator.subscribe = () => {
      subscribed = true
      return () => {}
    }
    const tool = createTaskWaitTool(makeDeps(coordinator))
    const result = await tool.execute(
      { run_ids: [child.runId], timeout_ms: 5_000 },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(true)
    expect(parseResult(result.output).reason).toBe('ready')
    // 已就绪立即返回，不应进入订阅
    expect(subscribed).toBe(false)
  })

  it('非目标 run 更新不唤醒等待', async () => {
    vi.useFakeTimers()
    try {
      const store = new SessionStore(root)
      const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
      const parent = store.create(resolve(root, 'workspace'))
      const parentRun = coordinator.startRun({
        kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
      })
      coordinator.markRunning(parentRun.runId, 'msg-parent')
      const target = setupChild(store, coordinator, parent.id, parentRun.runId, 'target')
      const other = setupChild(store, coordinator, parent.id, parentRun.runId, 'other')

      const tool = createTaskWaitTool(makeDeps(coordinator))

      // 用 deferred Promise 确认订阅已建立
      let resolveSubscribed: () => void
      const subscribed = new Promise<void>(resolve => { resolveSubscribed = resolve })
      const originalSubscribe = coordinator.subscribe.bind(coordinator)
      coordinator.subscribe = (listener) => {
        resolveSubscribed()
        return originalSubscribe(listener)
      }

      const waitPromise = tool.execute(
        { run_ids: [target.runId], timeout_ms: 200 },
        makeContext(store, parent.id, parentRun.runId)
      )
      // 确认订阅已建立后，对非目标 run 提交终态
      await subscribed
      coordinator.commitTerminal({
        runId: other.runId,
        status: 'completed',
        terminalTransitionId: 'terminal-other'
      })
      // 推进微任务：非目标 run 的终态不应唤醒等待
      await vi.advanceTimersByTimeAsync(0)
      let settled = false
      waitPromise.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      // 推进到 timeout：等待应因超时返回，target 仍 running
      await vi.advanceTimersByTimeAsync(200)
      const result = await waitPromise
      expect(result.success).toBe(true)
      expect(parseResult(result.output).reason).toBe('timeout')
      expect(parseResult(result.output).targets[0].runId).toBe(target.runId)
      expect(parseResult(result.output).targets[0].status).toBe('running')
      expect(coordinator.getSnapshot(other.runId)?.status).toBe('completed')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('task_wait 超时不取消子代理', () => {
  it('超时返回当前状态，子代理仍 running', async () => {
    vi.useFakeTimers()
    try {
      const store = new SessionStore(root)
      const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
      const parent = store.create(resolve(root, 'workspace'))
      const parentRun = coordinator.startRun({
        kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
      })
      coordinator.markRunning(parentRun.runId, 'msg-parent')
      const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-1')
      const tool = createTaskWaitTool(makeDeps(coordinator))

      const waitPromise = tool.execute(
        { run_ids: [child.runId], timeout_ms: 1 },
        makeContext(store, parent.id, parentRun.runId)
      )
      await vi.advanceTimersByTimeAsync(1)
      const result = await waitPromise
      expect(result.success).toBe(true)
      const payload = parseResult(result.output)
      expect(payload.reason).toBe('timeout')
      expect(payload.targets[0].status).toBe('running')
      expect(coordinator.getSnapshot(child.runId)?.status).toBe('running')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('task_wait abort 清理', () => {
  it('abortSignal 触发时返回失败，且 finally 清理订阅/timer/abort listener', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-1')
    const controller = new AbortController()
    const tool = createTaskWaitTool(makeDeps(coordinator))

    // 用 deferred Promise 确认订阅已建立后再 abort
    let resolveSubscribed: () => void
    const subscribed = new Promise<void>(resolve => { resolveSubscribed = resolve })
    let unsubscribeCalled = false
    const originalSubscribe = coordinator.subscribe.bind(coordinator)
    coordinator.subscribe = (listener) => {
      resolveSubscribed()
      const unsub = originalSubscribe(listener)
      return () => {
        unsubscribeCalled = true
        unsub()
      }
    }
    const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener')

    const waitPromise = tool.execute(
      { run_ids: [child.runId], timeout_ms: 10_000 },
      makeContext(store, parent.id, parentRun.runId, controller.signal)
    )
    await subscribed
    controller.abort()

    const result = await waitPromise
    expect(result.success).toBe(false)
    expect(result.error).toContain('取消')
    expect(coordinator.getSnapshot(child.runId)?.status).toBe('running')
    // finally 清理了订阅与 abort listener
    expect(unsubscribeCalled).toBe(true)
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('进入时已 aborted 立即返回失败，不进入订阅', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-1')
    const controller = new AbortController()
    controller.abort()

    let subscribed = false
    coordinator.subscribe = () => {
      subscribed = true
      return () => {}
    }
    const tool = createTaskWaitTool(makeDeps(coordinator))

    const result = await tool.execute(
      { run_ids: [child.runId], timeout_ms: 10_000 },
      makeContext(store, parent.id, parentRun.runId, controller.signal)
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('取消')
    // 已 aborted 在订阅前返回，不应进入订阅
    expect(subscribed).toBe(false)
  })
})

describe('task_wait 返回全部目标状态', () => {
  it('多个 run_ids 返回每个目标的当前状态', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child1 = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-1')
    const child2 = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-2')
    store.appendMessageFast(child2.childSessionId, {
      id: 'msg-child-child-2',
      role: 'assistant',
      content: 'child2 done',
      timestamp: 2
    })
    coordinator.commitTerminal({
      runId: child2.runId,
      status: 'completed',
      terminalTransitionId: 'terminal-2'
    })

    const tool = createTaskWaitTool(makeDeps(coordinator))
    const result = await tool.execute(
      { run_ids: [child1.runId, child2.runId] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(true)
    const payload = parseResult(result.output)
    expect(payload.reason).toBe('ready')
    expect(payload.targets).toHaveLength(2)
    const byId = Object.fromEntries(payload.targets.map(t => [t.runId, t]))
    expect(byId[child1.runId].status).toBe('running')
    expect(byId[child2.runId].status).toBe('completed')
  })
})

describe('task_wait subagentNotificationIds 元数据', () => {
  it('eligible terminal 成功结果的 ToolResult 精确包含去重 notificationId', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child1 = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-1')
    const child2 = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-2')
    store.appendMessageFast(child1.childSessionId, {
      id: 'msg-child-child-1', role: 'assistant', content: 'done1', timestamp: 2
    })
    store.appendMessageFast(child2.childSessionId, {
      id: 'msg-child-child-2', role: 'assistant', content: 'done2', timestamp: 2
    })
    coordinator.commitTerminal({ runId: child1.runId, status: 'completed', terminalTransitionId: 'terminal-1' })
    coordinator.commitTerminal({ runId: child2.runId, status: 'completed', terminalTransitionId: 'terminal-2' })

    const tool = createTaskWaitTool(makeDeps(coordinator))
    const result = await tool.execute(
      { run_ids: [child1.runId, child2.runId] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(true)
    expect(result.subagentNotificationIds).toEqual([
      `ntf_${child1.runId}_terminal-1`,
      `ntf_${child2.runId}_terminal-2`
    ])
  })

  it('同一 notificationId 出现多次时去重', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-dup')
    store.appendMessageFast(child.childSessionId, {
      id: 'msg-child-child-dup', role: 'assistant', content: 'done', timestamp: 2
    })
    coordinator.commitTerminal({ runId: child.runId, status: 'completed', terminalTransitionId: 'terminal-dup' })

    const tool = createTaskWaitTool(makeDeps(coordinator))
    // 同一 run_id 列两次，notificationId 应只出现一次
    const result = await tool.execute(
      { run_ids: [child.runId, child.runId] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(true)
    expect(result.subagentNotificationIds).toEqual([`ntf_${child.runId}_terminal-dup`])
  })

  it('waiting_user 结果不含 subagentNotificationIds', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-wu')
    coordinator.addInteraction({
      interactionId: 'inter-wu', runId: child.runId, sessionId: child.childSessionId,
      messageId: 'msg-child-wu', type: 'permission', status: 'pending',
      createdAt: Date.now(), version: 1, payload: {}
    })

    const tool = createTaskWaitTool(makeDeps(coordinator))
    const result = await tool.execute(
      { run_ids: [child.runId] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(true)
    expect(result.subagentNotificationIds).toBeUndefined()
  })

  it('timeout 且子代理仍 running 不含 subagentNotificationIds', async () => {
    vi.useFakeTimers()
    try {
      const store = new SessionStore(root)
      const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
      const parent = store.create(resolve(root, 'workspace'))
      const parentRun = coordinator.startRun({
        kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
      })
      coordinator.markRunning(parentRun.runId, 'msg-parent')
      const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-timeout')

      const tool = createTaskWaitTool(makeDeps(coordinator))
      const waitPromise = tool.execute(
        { run_ids: [child.runId], timeout_ms: 1 },
        makeContext(store, parent.id, parentRun.runId)
      )
      await vi.advanceTimersByTimeAsync(1)
      const result = await waitPromise
      expect(result.success).toBe(true)
      expect(result.subagentNotificationIds).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidated 终态不含 subagentNotificationIds', async () => {
    const store = new SessionStore(root)
    const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot: join(root, 'runs') }) })
    const parent = store.create(resolve(root, 'workspace'))
    const parentRun = coordinator.startRun({
      kind: 'agent', runId: 'parent', workspaceId: root, sessionId: parent.id
    })
    coordinator.markRunning(parentRun.runId, 'msg-parent')
    const child = setupChild(store, coordinator, parent.id, parentRun.runId, 'child-inv')
    coordinator.commitTerminal({ runId: child.runId, status: 'completed', terminalTransitionId: 'terminal-inv' })
    coordinator.updateDeliveryBinding(child.runId, { invalidatedReason: 'branch_invalidate:op' })

    const tool = createTaskWaitTool(makeDeps(coordinator))
    const result = await tool.execute(
      { run_ids: [child.runId] },
      makeContext(store, parent.id, parentRun.runId)
    )
    expect(result.success).toBe(true)
    expect(result.subagentNotificationIds).toBeUndefined()
  })
})
