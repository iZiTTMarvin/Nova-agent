import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { createHash } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRunCoordinator, RunExecutionRegistry } from '../../../../src/runtime/run'
import { SessionStore, deriveChildSessionId } from '../../../../src/runtime/sessions'
import {
  resolveSubagentProfileSnapshot,
  SubagentLifecycleCoordinator,
  SubagentScheduler
} from '../../../../src/runtime/subagents'
import { writerLeaseRegistry } from '../../../../src/runtime/workspace'
import type { SubagentRunDispatch } from '../../../../src/shared/run/types'
import * as atomicFile from '../../../../src/runtime/storage/atomicFile'

describe('SubagentLifecycleCoordinator', () => {
  let root: string
  let workspace: string
  let store: SessionStore
  let coordinator: ReturnType<typeof createRunCoordinator>
  let registry: RunExecutionRegistry
  let scheduler: SubagentScheduler
  let parentSessionId: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nova-subagent-lifecycle-'))
    workspace = resolve(root, 'workspace')
    store = new SessionStore(root)
    coordinator = createRunCoordinator(root)
    registry = new RunExecutionRegistry({ graceMs: 20 })
    scheduler = new SubagentScheduler()
    writerLeaseRegistry.resetForTests()
    parentSessionId = store.create(workspace).id
    createRun('run-parent', parentSessionId)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    writerLeaseRegistry.resetForTests()
    rmSync(root, { recursive: true, force: true })
  })

  function createRun(
    runId: string,
    sessionId: string,
    dispatch?: SubagentRunDispatch
  ): void {
    coordinator.startRun({
      kind: 'agent',
      runId,
      workspaceId: workspace,
      sessionId,
      ...(dispatch ? { dispatch } : {})
    })
    coordinator.markRunning(runId, `msg-${runId}`)
    coordinator.bindExecutionGeneration(runId, 1)
  }

  function createChild(
    parentId: string,
    parentRunId: string,
    childRunId: string,
    depth: number,
    execution: SubagentRunDispatch['execution'] = 'sync',
    parentMessageId = `msg-${parentRunId}`
  ) {
    const child = store.createChildIfAbsent({
      childSessionId: deriveChildSessionId(`key-${childRunId}`),
      workspaceRoot: workspace,
      mode: 'default',
      permissionMode: 'request_approval',
      task: childRunId,
      subagent: {
        lineage: {
          parentSessionId: parentId,
          parentRunId,
          rootRunId: 'run-parent',
          depth,
          spawnKey: `key-${childRunId}`,
          spawnRunId: childRunId,
          origin: {
            kind: 'task_tool',
            parentMessageId,
            parentToolCallId: `call-${childRunId}`
          }
        },
        profile: resolveSubagentProfileSnapshot({
          id: 'explore',
          name: 'explore',
          description: 'read only',
          prompt: 'inspect',
          allowedTools: ['read']
        }, 'explore')
      }
    }).session
    createRun(
      childRunId,
      child.id,
      execution === 'sync'
        ? undefined
        : {
            version: 1,
            callKind: 'task',
            parentSessionId: parentId,
            parentRunId,
            parentMessageId,
            parentToolCallId: `call-${childRunId}`,
            execution,
            topParentSessionId: parentSessionId
          }
    )
    return child
  }

  /** 落一个 queued 接力预约（无 turnStartedAt），等价于已持久化未接管的状态。 */
  function createQueuedRelay(
    runId: string,
    sessionId: string,
    anchorMessageId: string | null
  ): void {
    coordinator.startRun({
      kind: 'agent',
      runId,
      workspaceId: workspace,
      sessionId,
      relayTrigger: {
        version: 1,
        requestId: runId,
        receiveMessageId: `msg-${runId}`,
        originUserMessageId: 'user-1',
        anchorMessageId,
        items: [{ notificationId: `n-${runId}`, sourceRunId: 'src', content: 'x' }],
        createdAt: Date.now()
      }
    })
  }

  function registerSettlingHandle(runId: string) {
    let settle!: () => void
    const settled = new Promise<void>((resolveSettled) => { settle = resolveSettled })
    const abort = vi.fn(() => settle())
    registry.register({ runId, generation: 1, kind: 'agent', abort, settled })
    return abort
  }

  it('父取消先覆盖完整后代并 abort 各自句柄，最终全部 cancelled', async () => {
    const child = createChild(parentSessionId, 'run-parent', 'run-child', 1)
    createChild(child.id, 'run-child', 'run-grandchild', 2)
    const abortParent = registerSettlingHandle('run-parent')
    const abortChild = registerSettlingHandle('run-child')
    const abortGrandchild = registerSettlingHandle('run-grandchild')
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    expect(lifecycle.getRootRunId('run-grandchild')).toBe('run-parent')
    expect(lifecycle.getRootRunId('run-parent')).toBe('run-parent')
    const result = await lifecycle.cancelRunTree('run-parent', 'test_cancel')

    expect(result.requestedRunIds).toEqual(['run-parent', 'run-child', 'run-grandchild'])
    expect(new Set(result.cancelledRunIds)).toEqual(new Set(result.requestedRunIds))
    expect(abortParent).toHaveBeenCalledWith('test_cancel')
    expect(abortChild).toHaveBeenCalledWith('test_cancel')
    expect(abortGrandchild).toHaveBeenCalledWith('test_cancel')
    expect(result.requestedRunIds.map((id) => coordinator.getSnapshot(id)?.status))
      .toEqual(['cancelled', 'cancelled', 'cancelled'])
  })

  it('单独取消 child 不影响父 run', async () => {
    const child = createChild(parentSessionId, 'run-parent', 'run-child', 1)
    createChild(child.id, 'run-child', 'run-grandchild', 2)
    registerSettlingHandle('run-child')
    registerSettlingHandle('run-grandchild')
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    await lifecycle.cancelRunTree('run-child', 'child_cancel')

    expect(coordinator.getSnapshot('run-parent')?.status).toBe('running')
    expect(coordinator.getSnapshot('run-child')?.status).toBe('cancelled')
    expect(coordinator.getSnapshot('run-grandchild')?.status).toBe('cancelled')
  })

  it('单独取消后台 child 不释放父 writer lease', async () => {
    createChild(parentSessionId, 'run-parent', 'run-background-child', 1, 'background_read_only')
    await writerLeaseRegistry.acquire(workspace, 'run-parent')
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    const result = await lifecycle.cancelRunTree('run-background-child', 'child_cancel')

    expect(result.cancelledRunIds).toEqual(['run-background-child'])
    expect(coordinator.getSnapshot('run-parent')?.status).toBe('running')
    expect(writerLeaseRegistry.holder(workspace)).toBe('run-parent')
  })

  it('单独取消同步 child 仍释放共享 root writer lease', async () => {
    createChild(parentSessionId, 'run-parent', 'run-sync-child', 1)
    await writerLeaseRegistry.acquire(workspace, 'run-parent')
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    await lifecycle.cancelRunTree('run-sync-child', 'sync_child_cancel')

    expect(writerLeaseRegistry.holder(workspace)).toBeNull()
  })

  it('单独取消排队中的 child 会移除 Scheduler waiter', async () => {
    createChild(parentSessionId, 'run-parent', 'run-child', 1)
    scheduler = new SubagentScheduler({ globalLimit: 1, perRootLimit: 1, waitTimeoutMs: 100 })
    const occupied = await scheduler.acquire({
      runId: 'run-occupied',
      capacityKey: 'run-other',
      requestKey: 'occupied'
    })
    const waiting = scheduler.acquire({
      runId: 'run-child',
      capacityKey: 'run-parent',
      requestKey: 'child',
      wait: true
    })
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    await lifecycle.cancelRunTree('run-child', 'child_cancel')

    await expect(waiting).resolves.toEqual(expect.objectContaining({ ok: false, code: 'aborted' }))
    expect(coordinator.getSnapshot('run-child')?.status).toBe('cancelled')
    expect(coordinator.getSnapshot('run-parent')?.status).toBe('running')
    expect(scheduler.snapshot().queued).toBe(0)
    if (occupied.ok) occupied.permit.release()
  })

  it('grace 到期保留 lingering handle、失效 generation 并提交 interrupted', async () => {
    createChild(parentSessionId, 'run-parent', 'run-child', 1)
    registry.register({
      runId: 'run-child',
      generation: 1,
      kind: 'agent',
      abort: vi.fn(),
      settled: new Promise<void>(() => {})
    })
    const permit = await scheduler.acquire({
      runId: 'run-child',
      capacityKey: 'run-parent',
      requestKey: 'child'
    })
    if (!permit.ok) throw new Error('expected permit')
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    const result = await lifecycle.cancelRunTree('run-child', 'timeout', { graceMs: 1 })

    expect(result.interruptedRunIds).toEqual(['run-child'])
    expect(coordinator.getSnapshot('run-child')).toEqual(expect.objectContaining({
      status: 'interrupted',
      executionGeneration: 0
    }))
    expect(registry.get('run-child')).not.toBeNull()
    expect(scheduler.snapshot().activeGlobal).toBe(0)
    permit.permit.release()
  })

  it('退出时只把 active child 标记 interrupted，并释放 writer lease', async () => {
    createChild(parentSessionId, 'run-parent', 'run-child', 1)
    await writerLeaseRegistry.acquire(workspace, 'run-child')
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    const interrupted = await lifecycle.interruptActiveChildrenOnShutdown()

    expect(interrupted.map((run) => run.runId)).toEqual(['run-child'])
    expect(coordinator.getSnapshot('run-child')?.status).toBe('interrupted')
    expect(coordinator.getSnapshot('run-parent')?.status).toBe('running')
    expect(writerLeaseRegistry.holder(workspace)).toBeNull()
  })

  it('停止意图半套写入后重放收敛且幂等', async () => {
    createChild(parentSessionId, 'run-parent', 'run-child-a', 1)
    createChild(parentSessionId, 'run-parent', 'run-child-b', 1)
    // 半套写入：一个目标已终态，另一个仍是 running
    coordinator.commitTerminal({ runId: 'run-child-a', status: 'cancelled', reason: 'half' })
    const set = store.setControlIntent(parentSessionId, {
      version: 1,
      operationId: 'op_stop',
      kind: 'stop',
      targetRunIds: ['run-child-a', 'run-child-b'],
      targetSessionIds: [],
      requestedAt: Date.now()
    })
    expect(set).toEqual({ ok: true })
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    const result = await lifecycle.replayControlIntents()

    expect(result.replayedOperationIds).toContain('op_stop')
    expect(result.retained).toEqual([])
    expect(coordinator.getSnapshot('run-child-b')?.status).toBe('cancelled')
    expect(coordinator.getSnapshot('run-child-a')?.status).toBe('cancelled')
    expect(store.getControlIntent(parentSessionId)).toBeNull()

    // 无意图可放：重放幂等且无副作用
    const second = await lifecycle.replayControlIntents()
    expect(second.replayedOperationIds).toEqual([])
    expect(second.retained).toEqual([])
  })

  it('崩溃残留 running 的目标经停止意图重放收敛为 cancelled 而非 interrupted', async () => {
    createChild(parentSessionId, 'run-parent', 'run-child-crash', 1)
    store.setControlIntent(parentSessionId, {
      version: 1,
      operationId: 'op_crash',
      kind: 'stop',
      targetRunIds: ['run-child-crash'],
      targetSessionIds: [],
      requestedAt: Date.now()
    })
    // 模拟进程重启：新 coordinator 无内存状态，registry 无活句柄
    const coldCoordinator = createRunCoordinator(root)
    const coldRegistry = new RunExecutionRegistry({ graceMs: 20 })
    const lifecycle = new SubagentLifecycleCoordinator(store, coldCoordinator, coldRegistry, scheduler)

    const result = await lifecycle.replayControlIntents()

    expect(result.retained).toEqual([])
    expect(coldCoordinator.getSnapshot('run-child-crash')?.status).toBe('cancelled')
  })

  it('停止链路先提交持久意图再收敛，目标全部提交后清除意图', async () => {
    createChild(parentSessionId, 'run-parent', 'run-child-stop', 1, 'background_read_only')
    // 阻塞父句柄：处理途中可观察持久意图与失效化记录
    const slowRegistry = new RunExecutionRegistry({ graceMs: 5_000 })
    let releaseSettled!: () => void
    const settled = new Promise<void>((resolve) => { releaseSettled = resolve })
    slowRegistry.register({
      runId: 'run-parent',
      generation: 1,
      kind: 'agent',
      abort: vi.fn(),
      settled
    })
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, slowRegistry, scheduler)

    const stopping = lifecycle.stopRunTree('run-parent', 'cancel_execution')
    await vi.waitFor(() =>
      expect(store.getControlIntent(parentSessionId)).not.toBeNull()
    )
    // 冻结目标覆盖整棵树；意图提交先于取消处理
    expect(store.getControlIntent(parentSessionId)).toEqual(expect.objectContaining({
      kind: 'stop',
      targetRunIds: expect.arrayContaining(['run-parent', 'run-child-stop'])
    }))
    // 失效化记录先于 abort/join 落盘：带 dispatch 的投递源被抑制，普通父 run 不写
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot('run-child-stop')?.deliveryBinding?.invalidatedReason)
        .toBe('control_intent:stop:run-parent')
    )
    expect(coordinator.getSnapshot('run-parent')?.deliveryBinding).toBeUndefined()
    expect(coordinator.getSnapshot('run-child-stop')?.status).toBe('cancelling')

    releaseSettled()
    const result = await stopping

    expect(store.getControlIntent(parentSessionId)).toBeNull()
    expect(result.cancelledRunIds).toEqual(expect.arrayContaining(['run-parent', 'run-child-stop']))
    expect(coordinator.getSnapshot('run-parent')?.status).toBe('cancelled')
    expect(coordinator.getSnapshot('run-child-stop')?.status).toBe('cancelled')
  })

  it('停止意图重放失效化已终态投递源的绑定，完成通知不再唤醒父级', async () => {
    createChild(parentSessionId, 'run-parent', 'run-child-done', 1, 'background_read_only')
    coordinator.commitTerminal({ runId: 'run-child-done', status: 'completed' })
    coordinator.updateDeliveryBinding('run-child-done', {
      boundRunId: 'run-parent',
      boundSessionId: parentSessionId
    })
    store.setControlIntent(parentSessionId, {
      version: 1,
      operationId: 'op_stop_done',
      kind: 'stop',
      targetRunIds: ['run-parent', 'run-child-done'],
      targetSessionIds: [],
      requestedAt: Date.now()
    })
    // 模拟进程重启：冷 coordinator 无内存状态
    const coldCoordinator = createRunCoordinator(root)
    const coldRegistry = new RunExecutionRegistry({ graceMs: 20 })
    const lifecycle = new SubagentLifecycleCoordinator(store, coldCoordinator, coldRegistry, scheduler)

    const result = await lifecycle.replayControlIntents()

    expect(result.retained).toEqual([])
    // 已终态目标不重写终态，但投递绑定补写失效化
    expect(coldCoordinator.getSnapshot('run-child-done')?.status).toBe('completed')
    expect(coldCoordinator.getSnapshot('run-child-done')?.deliveryBinding).toEqual(
      expect.objectContaining({
        boundRunId: 'run-parent',
        invalidatedReason: 'control_intent:op_stop_done'
      })
    )
    // 无 dispatch 的根目标没有投递语义，不写绑定
    expect(coldCoordinator.getSnapshot('run-parent')?.deliveryBinding).toBeUndefined()
    expect(store.getControlIntent(parentSessionId)).toBeNull()
  })

  it('停止意图宿主会话缺失时尽力取消并如实失败，不假装已持久停止', async () => {
    createChild(parentSessionId, 'run-parent', 'run-child-hostless', 1)
    expect(store.delete(parentSessionId)).toBe(true)
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    await expect(lifecycle.stopRunTree('run-parent', 'cancel_execution'))
      .rejects.toThrow(/停止未持久化/)

    expect(coordinator.getSnapshot('run-parent')?.status).toBe('cancelled')
    expect(coordinator.getSnapshot('run-child-hostless')?.status).toBe('cancelled')
  })

  it('同会话意图冲突时拒绝新停止，不执行未持久化的目标集合', async () => {
    createChild(parentSessionId, 'run-parent', 'run-child-conflict', 1, 'background_read_only')
    store.setControlIntent(parentSessionId, {
      version: 1,
      operationId: 'op_stop_existing',
      kind: 'stop',
      targetRunIds: ['run-child-conflict'],
      targetSessionIds: [],
      requestedAt: Date.now()
    })
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    await expect(lifecycle.stopRunTree('run-parent', 'cancel_execution'))
      .rejects.toThrow(/已有未完成的控制意图/)

    expect(coordinator.getSnapshot('run-parent')?.status).toBe('running')
    expect(coordinator.getSnapshot('run-child-conflict')?.deliveryBinding).toBeUndefined()
    expect(store.getControlIntent(parentSessionId)?.targetRunIds).toEqual(['run-child-conflict'])
    await lifecycle.replayControlIntents()
    expect(coordinator.getSnapshot('run-child-conflict')?.status).toBe('cancelled')
    expect(coordinator.getSnapshot('run-parent')?.status).toBe('running')
  })

  it('意图写盘失败仍取消真实句柄，保留本进程接纳冻结且同操作可重试', async () => {
    createChild(parentSessionId, 'run-parent', 'run-child-write-fail', 1, 'background_read_only')
    const abortParent = registerSettlingHandle('run-parent')
    const abortChild = registerSettlingHandle('run-child-write-fail')
    const write = atomicFile.atomicWriteFileSync
    const metadataPath = join(root, 'sessions', parentSessionId, 'session.json')
    const fault = vi.spyOn(atomicFile, 'atomicWriteFileSync').mockImplementation((file, content, encoding) => {
      if (file === metadataPath) throw new Error('intent disk full')
      write(file, content, encoding)
    })
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    await expect(lifecycle.stopRunTree('run-parent', 'cancel_execution'))
      .rejects.toThrow(/intent disk full/)

    expect(abortParent).toHaveBeenCalledTimes(1)
    expect(abortChild).toHaveBeenCalledTimes(1)
    expect(registry.listActiveRunIds()).toEqual([])
    expect(store.getControlIntent(parentSessionId)?.targetRunIds)
      .toEqual(['run-parent', 'run-child-write-fail'])
    expect(new SessionStore(root).getControlIntent(parentSessionId)).toBeNull()
    fault.mockRestore()
    await lifecycle.stopRunTree('run-parent', 'cancel_execution')
    expect(store.getControlIntent(parentSessionId)).toBeNull()
    expect(new SessionStore(root).getControlIntent(parentSessionId)).toBeNull()
    expect(coordinator.getSnapshot('run-child-write-fail')?.deliveryBinding?.invalidatedReason)
      .toBe('control_intent:stop:run-parent')
  })

  it('run 快照持续写入失败仍取消所有句柄，恢复存储后按原意图收敛', async () => {
    createChild(parentSessionId, 'run-parent', 'run-child-disk-fail', 1, 'background_read_only')
    const abortParent = registerSettlingHandle('run-parent')
    const abortChild = registerSettlingHandle('run-child-disk-fail')
    const write = atomicFile.atomicWriteFileSync
    const fault = vi.spyOn(atomicFile, 'atomicWriteFileSync').mockImplementation((file, content, encoding) => {
      if (file.endsWith('snapshot.json')) throw new Error('run disk full')
      write(file, content, encoding)
    })
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)
    await expect(lifecycle.stopRunTree('run-parent', 'cancel_execution'))
      .rejects.toThrow(/控制意图已保留/)
    expect(abortParent).toHaveBeenCalledTimes(1)
    expect(abortChild).toHaveBeenCalledTimes(1)
    expect(registry.listActiveRunIds()).toEqual([])
    expect(new SessionStore(root).getControlIntent(parentSessionId)?.operationId).toBe('stop:run-parent')
    fault.mockRestore()

    await lifecycle.stopRunTree('run-parent', 'cancel_execution')

    expect(store.getControlIntent(parentSessionId)).toBeNull()
    const cold = createRunCoordinator(root)
    expect(cold.getSnapshot('run-parent')?.status).toBe('cancelled')
    expect(cold.getSnapshot('run-child-disk-fail')?.status).toBe('cancelled')
    expect(cold.getSnapshot('run-child-disk-fail')?.deliveryBinding?.invalidatedReason)
      .toBe('control_intent:stop:run-parent')
  })

  it('删除意图：run 先删、会话子先父后、半删除可重试', async () => {
    const child = createChild(parentSessionId, 'run-parent', 'run-child-del', 1)
    store.setControlIntent(parentSessionId, {
      version: 1,
      operationId: 'op_del',
      kind: 'delete',
      targetRunIds: [],
      targetSessionIds: [child.id, parentSessionId],
      requestedAt: Date.now()
    })
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    const result = await lifecycle.replayControlIntents()

    expect(result.retained).toEqual([])
    expect(store.load(child.id)).toBeNull()
    expect(store.load(parentSessionId)).toBeNull()
    expect(coordinator.getSnapshot('run-child-del')).toBeNull()
    // 意图随父元数据删除
    expect(store.getControlIntent(parentSessionId)).toBeNull()

    // 半删除：child 目录已手工移除，只剩父会话 + 意图，重放仍收敛
    const parent2 = store.create(workspace).id
    const child2 = createChild(parent2, 'run-parent', 'run-child-half', 1)
    store.setControlIntent(parent2, {
      version: 1,
      operationId: 'op_half',
      kind: 'delete',
      targetRunIds: [],
      targetSessionIds: [child2.id, parent2],
      requestedAt: Date.now()
    })
    expect(store.delete(child2.id)).toBe(true)

    const retried = await lifecycle.replayControlIntents()

    expect(retried.replayedOperationIds).toContain('op_half')
    expect(retried.retained).toEqual([])
    expect(store.load(parent2)).toBeNull()
    expect(coordinator.getSnapshot('run-child-half')).toBeNull()
  })

  it('范围查询按 per-run 派遣关联覆盖 followup 归属', async () => {
    const child = createChild(parentSessionId, 'run-old', 'run-birth', 1)
    createRun('run-new', parentSessionId)
    const dispatch: SubagentRunDispatch = {
      version: 1,
      callKind: 'task_followup',
      parentSessionId: parentSessionId,
      parentRunId: 'run-new',
      parentMessageId: 'msg',
      execution: 'sync',
      topParentSessionId: parentSessionId
    }
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-fu',
      workspaceId: workspace,
      sessionId: child.id,
      dispatch
    })
    coordinator.markRunning('run-fu')
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    // followup 的新 run 归属新父轮；出生 lineage 只覆盖无 dispatch 的旧记录
    expect(lifecycle.listDescendantRunIds('run-new')).toContain('run-fu')
    expect(lifecycle.listDescendantRunIds('run-old')).not.toContain('run-fu')
    expect(lifecycle.listDescendantRunIds('run-old')).toContain('run-birth')

    const result = await lifecycle.cancelRunTree('run-new', 'followup_cancel')

    expect(result.cancelledRunIds).toContain('run-fu')
    expect(coordinator.getSnapshot('run-fu')?.status).toBe('cancelled')
    expect(coordinator.getSnapshot('run-birth')?.status).toBe('running')
  })

  it('父会话停止覆盖此前轮次的后台 child、可投递通知源与排队接力', async () => {
    // 已终态的上一父轮：其派出的后台 child 仍在运行
    createRun('run-parent-old', parentSessionId)
    coordinator.commitTerminal({ runId: 'run-parent-old', status: 'completed' })
    createChild(parentSessionId, 'run-parent-old', 'run-bg-old', 1, 'background_read_only')
    // 当前父轮派出的已完成可投递 child
    createChild(parentSessionId, 'run-parent', 'run-bg-done', 1, 'background_read_only')
    coordinator.commitTerminal({
      runId: 'run-bg-done',
      status: 'completed',
      terminalTransitionId: 'tt-done'
    })
    // 父会话上的排队接力预约（非终态 run）
    createQueuedRelay('run-relay', parentSessionId, 'msg-run-parent')
    registerSettlingHandle('run-parent')
    registerSettlingHandle('run-bg-old')
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    const result = await lifecycle.stopRunTree('run-parent', 'cancel_execution')

    // 冻结集合覆盖全部目标；requestedRunIds 只含需要取消的非终态项
    expect(new Set(result.requestedRunIds)).toEqual(new Set([
      'run-parent', 'run-bg-old', 'run-relay'
    ]))
    expect(coordinator.getSnapshot('run-parent')?.status).toBe('cancelled')
    expect(coordinator.getSnapshot('run-bg-old')?.status).toBe('cancelled')
    expect(coordinator.getSnapshot('run-relay')?.status).toBe('cancelled')
    // 已终态可投递源不改终态但补失效化，完成通知不再唤醒父级
    expect(coordinator.getSnapshot('run-bg-done')).toEqual(expect.objectContaining({
      status: 'completed',
      deliveryBinding: expect.objectContaining({
        invalidatedReason: 'control_intent:stop:run-parent'
      })
    }))
    // 已终态的上一父轮不进冻结集合
    expect(coordinator.getSnapshot('run-parent-old')?.status).toBe('completed')
    expect(store.getControlIntent(parentSessionId)).toBeNull()
  })

  it('单独停止 child 只覆盖该 child 会话子树，不影响父会话其他分支', async () => {
    const childA = createChild(parentSessionId, 'run-parent', 'run-child-a', 1)
    createChild(parentSessionId, 'run-parent', 'run-child-b', 1)
    // child-a 会话内由已终态旧轮派出的后台 grandchild：只经会话级扩展覆盖
    createRun('run-child-a-old', childA.id)
    coordinator.commitTerminal({ runId: 'run-child-a-old', status: 'completed' })
    createChild(childA.id, 'run-child-a-old', 'run-bg-gc', 2, 'background_read_only')
    registerSettlingHandle('run-child-a')
    registerSettlingHandle('run-bg-gc')
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    await lifecycle.stopRunTree('run-child-a', 'cancel_execution')

    expect(coordinator.getSnapshot('run-child-a')?.status).toBe('cancelled')
    expect(coordinator.getSnapshot('run-bg-gc')?.status).toBe('cancelled')
    expect(coordinator.getSnapshot('run-child-b')?.status).toBe('running')
    expect(coordinator.getSnapshot('run-parent')?.status).toBe('running')
    expect(coordinator.getSnapshot('run-child-a-old')?.status).toBe('completed')
  })

  it('停止在意图落盘后才释放交互等待', async () => {
    createChild(parentSessionId, 'run-parent', 'run-child-rel', 1)
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)
    const observed: string[] = []

    await lifecycle.stopRunTree('run-parent', 'cancel_execution', {
      releaseInteractions: (targetRunIds) => {
        observed.push(
          `${store.getControlIntent(parentSessionId)?.operationId ?? 'none'}:${targetRunIds.length}`
        )
      }
    })

    expect(observed).toEqual(['stop:run-parent:2'])
    expect(store.getControlIntent(parentSessionId)).toBeNull()
  })

  it('退出收敛先 abort 真实句柄：grace 内自行终态的保留结果，未收敛标 interrupted', async () => {
    createChild(parentSessionId, 'run-parent', 'run-child-ok', 1)
    createChild(parentSessionId, 'run-parent', 'run-child-stuck', 1)
    const abortOk = vi.fn(() => {
      coordinator.commitTerminal({ runId: 'run-child-ok', status: 'completed' })
      settleOk()
    })
    let settleOk!: () => void
    registry.register({
      runId: 'run-child-ok',
      generation: 1,
      kind: 'agent',
      abort: abortOk,
      settled: new Promise<void>((resolve) => { settleOk = resolve })
    })
    const abortStuck = vi.fn()
    registry.register({
      runId: 'run-child-stuck',
      generation: 1,
      kind: 'agent',
      abort: abortStuck,
      settled: new Promise<void>(() => {})
    })
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    const interrupted = await lifecycle.interruptActiveChildrenOnShutdown(20)

    expect(abortOk).toHaveBeenCalledWith('process_exit')
    expect(abortStuck).toHaveBeenCalledWith('process_exit')
    // abort 后 grace 内自行提交终态：保留其自身结果，不覆写为 interrupted
    expect(interrupted.map((run) => run.runId)).toEqual(['run-child-stuck'])
    expect(coordinator.getSnapshot('run-child-ok')?.status).toBe('completed')
    expect(coordinator.getSnapshot('run-child-stuck')).toEqual(expect.objectContaining({
      status: 'interrupted',
      executionGeneration: 0
    }))
    // lingering 句柄保留在 registry，不伪装已结束
    expect(registry.get('run-child-stuck')).not.toBeNull()
  })

  it('分支失效化先持久意图再逐项失效化，锚点保留的源与接力不受影响', () => {
    createChild(parentSessionId, 'run-parent', 'run-bg-drop', 1, 'background_read_only', 'msg-drop')
    coordinator.commitTerminal({
      runId: 'run-bg-drop',
      status: 'completed',
      terminalTransitionId: 'tt-drop'
    })
    createChild(parentSessionId, 'run-parent', 'run-bg-keep', 1, 'background_read_only', 'msg-keep')
    coordinator.commitTerminal({
      runId: 'run-bg-keep',
      status: 'completed',
      terminalTransitionId: 'tt-keep'
    })
    createQueuedRelay('run-relay-drop', parentSessionId, 'msg-drop')
    createQueuedRelay('run-relay-keep', parentSessionId, 'msg-keep')
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    lifecycle.invalidateBranchDelivery(parentSessionId, new Set(['msg-drop']))

    expect(coordinator.getSnapshot('run-bg-drop')?.deliveryBinding?.invalidatedReason)
      .toMatch(/^branch_invalidate:branch:/)
    expect(coordinator.getSnapshot('run-bg-keep')?.deliveryBinding).toBeUndefined()
    expect(coordinator.getSnapshot('run-relay-drop')?.status).toBe('cancelled')
    expect(coordinator.getSnapshot('run-relay-keep')?.status).toBe('queued')
    expect(coordinator.getSnapshot('run-parent')?.status).toBe('running')
    expect(store.getControlIntent(parentSessionId)).toBeNull()
  })

  it('分支失效化意图重放只补完失效化，不执行分支切换', async () => {
    createChild(parentSessionId, 'run-parent', 'run-bg-half', 1, 'background_read_only', 'msg-drop')
    coordinator.commitTerminal({
      runId: 'run-bg-half',
      status: 'completed',
      terminalTransitionId: 'tt-half'
    })
    createQueuedRelay('run-relay-half', parentSessionId, 'msg-drop')
    store.setControlIntent(parentSessionId, {
      version: 1,
      operationId: 'op_branch',
      kind: 'branch_invalidate',
      targetRunIds: ['run-bg-half', 'run-relay-half'],
      targetSessionIds: [],
      requestedAt: Date.now()
    })
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    const result = await lifecycle.replayControlIntents()

    expect(result.retained).toEqual([])
    expect(coordinator.getSnapshot('run-bg-half')?.deliveryBinding?.invalidatedReason)
      .toBe('branch_invalidate:op_branch')
    expect(coordinator.getSnapshot('run-relay-half')?.status).toBe('cancelled')
    expect(store.getControlIntent(parentSessionId)).toBeNull()
  })

  it('已有其他控制意图时分支失效化拒绝，不写任何失效化记录', () => {
    store.setControlIntent(parentSessionId, {
      version: 1,
      operationId: 'op_stop_x',
      kind: 'stop',
      targetRunIds: ['run-parent'],
      targetSessionIds: [],
      requestedAt: Date.now()
    })
    createChild(parentSessionId, 'run-parent', 'run-bg-x', 1, 'background_read_only', 'msg-drop')
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    expect(() => lifecycle.invalidateBranchDelivery(parentSessionId, new Set(['msg-drop'])))
      .toThrow(/已有未完成的控制意图/)
    expect(coordinator.getSnapshot('run-bg-x')?.deliveryBinding).toBeUndefined()
    expect(store.getControlIntent(parentSessionId)?.operationId).toBe('op_stop_x')
  })

  it('同一切换中断后重试分支失效化：补完旧冻结目标并清除，不因目标收缩死锁', () => {
    createChild(parentSessionId, 'run-parent', 'run-bg-drop', 1, 'background_read_only', 'msg-drop')
    coordinator.commitTerminal({
      runId: 'run-bg-drop',
      status: 'completed',
      terminalTransitionId: 'tt-drop'
    })
    createQueuedRelay('run-relay-drop', parentSessionId, 'msg-drop')
    // 首次尝试中断于「意图已持久化 + 接力已取消」：重试时重算集合只剩派遣源，与冻结目标不再一致
    coordinator.commitTerminal({ runId: 'run-relay-drop', status: 'cancelled', reason: 'first_attempt' })
    const operationId = `branch:${parentSessionId}:${
      createHash('sha1').update('msg-drop').digest('hex').slice(0, 16)
    }`
    store.setControlIntent(parentSessionId, {
      version: 1,
      operationId,
      kind: 'branch_invalidate',
      targetRunIds: ['run-bg-drop', 'run-relay-drop'],
      targetSessionIds: [],
      requestedAt: Date.now()
    })
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    expect(() => lifecycle.invalidateBranchDelivery(parentSessionId, new Set(['msg-drop'])))
      .not.toThrow()

    expect(coordinator.getSnapshot('run-bg-drop')?.deliveryBinding?.invalidatedReason)
      .toBe(`branch_invalidate:${operationId}`)
    expect(store.getControlIntent(parentSessionId)).toBeNull()
  })

  it('停止意图同操作中断后重试：补完旧冻结目标并清除，不因集合收缩死锁', async () => {
    createChild(parentSessionId, 'run-parent', 'run-bg-old', 1, 'background_read_only', 'msg-old')
    coordinator.commitTerminal({
      runId: 'run-bg-old',
      status: 'completed',
      terminalTransitionId: 'tt-old'
    })
    // 首次停止已写失效化但未清意图：重算冻结集合时该源已不可投递、被排除
    coordinator.updateDeliveryBinding('run-bg-old', {
      invalidatedReason: 'control_intent:stop:run-parent'
    })
    store.setControlIntent(parentSessionId, {
      version: 1,
      operationId: 'stop:run-parent',
      kind: 'stop',
      targetRunIds: ['run-parent', 'run-bg-old'],
      targetSessionIds: [],
      requestedAt: Date.now()
    })
    const lifecycle = new SubagentLifecycleCoordinator(store, coordinator, registry, scheduler)

    await expect(lifecycle.stopRunTree('run-parent', 'retry_stop')).resolves.toBeDefined()

    expect(coordinator.getSnapshot('run-parent')?.status).toBe('cancelled')
    expect(store.getControlIntent(parentSessionId)).toBeNull()
  })
})
