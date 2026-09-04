import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLoop } from '../../../../src/runtime/agent'
import {
  AgentTurnExecutor,
  agentRoute
} from '../../../../src/runtime/agent/turn'
import {
  createRunCoordinator,
  RunExecutionRegistry
} from '../../../../src/runtime/run'

function fakeLoop(sendMessage: () => Promise<any>) {
  let fence = (): boolean => false
  const loop = {
    setExecutionIdentity: vi.fn(),
    setExecutionFence: vi.fn((next: () => boolean) => { fence = next }),
    cancel: vi.fn(),
    sendMessage: vi.fn(sendMessage)
  } as unknown as AgentLoop
  return { loop, getFence: () => fence }
}

describe('AgentTurnExecutor', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'nova-turn-executor-'))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('统一执行 start/register/bind/send/terminal/unregister/cleanup 生命周期', async () => {
    const coordinator = createRunCoordinator(tempRoot)
    const registry = new RunExecutionRegistry()
    const executor = new AgentTurnExecutor(coordinator, registry)
    const fake = fakeLoop(async () => ({ status: 'completed' }))
    const cleanup = vi.fn()
    const runRefs = { runId: '', resourceOwnerRunId: '', executionGeneration: 0 }

    const executed = await executor.execute({
      agentLoop: fake.loop,
      task: 'hello',
      route: agentRoute(),
      sessionId: 'sess-1',
      workingDirectory: tempRoot,
      isolation: 'shared',
      userMessageId: 'user-1',
      runRefs,
      onCleanup: cleanup
    })

    expect(executed.outcome).toEqual({ status: 'completed' })
    expect(coordinator.getSnapshot(executed.runId)?.status).toBe('completed')
    expect(fake.loop.setExecutionIdentity).toHaveBeenCalledWith({
      runId: executed.runId,
      resourceOwnerRunId: executed.runId
    })
    expect(runRefs).toEqual({
      runId: executed.runId,
      resourceOwnerRunId: executed.runId,
      executionGeneration: executed.executionGeneration
    })
    expect(registry.get(executed.runId)).toBeNull()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('sendMessage rejection 收敛为 interrupted，仍清 registry 与运行期资源', async () => {
    const coordinator = createRunCoordinator(tempRoot)
    const registry = new RunExecutionRegistry()
    const executor = new AgentTurnExecutor(coordinator, registry)
    const fake = fakeLoop(async () => { throw new Error('loop setup failed') })
    const cleanup = vi.fn()
    let startedRunId = ''

    await expect(executor.execute({
      agentLoop: fake.loop,
      task: 'hello',
      route: agentRoute(),
      sessionId: 'sess-1',
      workingDirectory: tempRoot,
      isolation: 'shared',
      userMessageId: 'user-1',
      onStarted: (context) => { startedRunId = context.runId },
      onCleanup: cleanup
    })).rejects.toThrow(/loop setup failed/)

    expect(coordinator.getSnapshot(startedRunId)?.status).toBe('interrupted')
    expect(registry.get(startedRunId)).toBeNull()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('incomplete 轮次 → durable run 按 completed 收，截断原因落 incompleteReason，outcome 原样返回', async () => {
    const coordinator = createRunCoordinator(tempRoot)
    const registry = new RunExecutionRegistry()
    const executor = new AgentTurnExecutor(coordinator, registry)
    const fake = fakeLoop(async () => ({ status: 'incomplete', reason: 'max_rounds' }))
    const cleanup = vi.fn()
    const runRefs = { runId: '', resourceOwnerRunId: '', executionGeneration: 0 }

    const executed = await executor.execute({
      agentLoop: fake.loop,
      task: 'hello',
      route: agentRoute(),
      sessionId: 'sess-1',
      workingDirectory: tempRoot,
      isolation: 'shared',
      userMessageId: 'user-1',
      runRefs,
      onCleanup: cleanup
    })

    expect(executed.outcome).toEqual({ status: 'incomplete', reason: 'max_rounds' })
    const terminal = coordinator.getSnapshot(executed.runId)
    expect(terminal?.status).toBe('completed')
    expect(terminal?.incompleteReason).toBe('max_rounds')
    expect(registry.get(executed.runId)).toBeNull()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('cancelled 轮次 → durable cancelled，不携带 incompleteReason（取消优先于截断）', async () => {
    const coordinator = createRunCoordinator(tempRoot)
    const registry = new RunExecutionRegistry()
    const executor = new AgentTurnExecutor(coordinator, registry)
    const fake = fakeLoop(async () => ({ status: 'cancelled' }))
    const cleanup = vi.fn()
    const runRefs = { runId: '', resourceOwnerRunId: '', executionGeneration: 0 }

    const executed = await executor.execute({
      agentLoop: fake.loop,
      task: 'hello',
      route: agentRoute(),
      sessionId: 'sess-1',
      workingDirectory: tempRoot,
      isolation: 'shared',
      userMessageId: 'user-1',
      runRefs,
      onCleanup: cleanup
    })

    const terminal = coordinator.getSnapshot(executed.runId)
    expect(terminal?.status).toBe('cancelled')
    expect(terminal?.incompleteReason).toBeUndefined()
  })

  it('delegated fence 同时要求 child 与 root generation 当前', async () => {
    const coordinator = createRunCoordinator(tempRoot)
    const registry = new RunExecutionRegistry()
    const executor = new AgentTurnExecutor(coordinator, registry)
    const root = coordinator.startRun({
      kind: 'agent',
      runId: 'run-root',
      workspaceId: tempRoot,
      sessionId: 'sess-root'
    })
    coordinator.markRunning(root.runId)
    coordinator.bindExecutionGeneration(root.runId, 7)

    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const fake = fakeLoop(async () => {
      await waiting
      return { status: 'completed' }
    })
    let childRunId = ''
    let execution!: Promise<unknown>
    const started = new Promise<void>((resolve) => {
      execution = executor.execute({
        agentLoop: fake.loop,
        task: 'child',
        route: agentRoute(),
        sessionId: 'sess-child',
        workingDirectory: tempRoot,
        isolation: 'shared',
        runId: 'run-child',
        resourceOwnerRunId: root.runId,
        resourceOwnerGeneration: 7,
        userMessageId: 'user-child',
        onStarted: (context) => {
          childRunId = context.runId
          resolve()
        }
      })
    })
    await started

    expect(fake.getFence()()).toBe(true)
    coordinator.invalidateExecutionGeneration(root.runId)
    expect(fake.getFence()()).toBe(false)
    coordinator.bindExecutionGeneration(root.runId, 7)
    expect(fake.getFence()()).toBe(true)

    coordinator.invalidateExecutionGeneration(childRunId)
    expect(fake.getFence()()).toBe(false)

    release()
    await execution
  })
})
