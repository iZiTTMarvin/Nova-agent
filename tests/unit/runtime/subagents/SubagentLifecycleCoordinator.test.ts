import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRunCoordinator, RunExecutionRegistry } from '../../../../src/runtime/run'
import { SessionStore } from '../../../../src/runtime/sessions'
import {
  resolveSubagentProfileSnapshot,
  SubagentLifecycleCoordinator,
  SubagentScheduler
} from '../../../../src/runtime/subagents'
import { writerLeaseRegistry } from '../../../../src/runtime/workspace'

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
    writerLeaseRegistry.resetForTests()
    rmSync(root, { recursive: true, force: true })
  })

  function createRun(runId: string, sessionId: string): void {
    coordinator.startRun({ kind: 'agent', runId, workspaceId: workspace, sessionId })
    coordinator.markRunning(runId, `msg-${runId}`)
    coordinator.bindExecutionGeneration(runId, 1)
  }

  function createChild(parentId: string, parentRunId: string, childRunId: string, depth: number) {
    const child = store.createChildIfAbsent({
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
            parentMessageId: `msg-${parentRunId}`,
            parentToolCallId: `call-${childRunId}`
          }
        },
        profile: resolveSubagentProfileSnapshot({
          name: 'explore',
          description: 'read only',
          prompt: 'inspect',
          allowedTools: ['read']
        }, 'explore')
      }
    }).session
    createRun(childRunId, child.id)
    return child
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
      rootRunId: 'run-parent',
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

    const interrupted = lifecycle.interruptActiveChildrenOnShutdown()

    expect(interrupted.map((run) => run.runId)).toEqual(['run-child'])
    expect(coordinator.getSnapshot('run-child')?.status).toBe('interrupted')
    expect(coordinator.getSnapshot('run-parent')?.status).toBe('running')
    expect(writerLeaseRegistry.holder(workspace)).toBeNull()
  })
})
