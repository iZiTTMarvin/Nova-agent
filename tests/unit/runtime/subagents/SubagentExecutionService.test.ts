import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLoop } from '../../../../src/runtime/agent'
import { EventBus } from '../../../../src/runtime/agent'
import { AgentTurnExecutor } from '../../../../src/runtime/agent/turn'
import {
  createRunCoordinator,
  RunExecutionRegistry
} from '../../../../src/runtime/run'
import { SessionStore } from '../../../../src/runtime/sessions'
import {
  MAX_SUBAGENT_SUMMARY_CHARS,
  SubagentExecutionService,
  SubagentScheduler,
  createSpawnIdentity,
  resolveSubagentProfileSnapshot,
  type SubagentExecutionServiceDeps
} from '../../../../src/runtime/subagents'
import type { SpawnSubagentCommand } from '../../../../src/shared/subagents'

const profile = {
  name: 'explore',
  description: 'read only exploration',
  allowedTools: ['read', 'grep'],
  prompt: 'inspect and summarize',
  maxToolRounds: 20
}

describe('SubagentExecutionService', () => {
  let tempRoot: string
  let workspace: string
  let sessionStore: SessionStore
  let coordinator: ReturnType<typeof createRunCoordinator>
  let parentSessionId: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'nova-subagent-service-'))
    workspace = resolve(tempRoot, 'workspace')
    sessionStore = new SessionStore(tempRoot)
    parentSessionId = sessionStore.create(workspace).id
    coordinator = createRunCoordinator(tempRoot)
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-parent',
      workspaceId: workspace,
      sessionId: parentSessionId
    })
    coordinator.markRunning('run-parent', 'msg-parent')
    coordinator.bindExecutionGeneration('run-parent', 41)
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  function command(overrides: Partial<SpawnSubagentCommand> = {}): SpawnSubagentCommand {
    return {
      parentSessionId,
      parentRunId: 'run-parent',
      invocation: {
        kind: 'task_tool',
        parentMessageId: 'msg-parent',
        parentToolCallId: 'call-task'
      },
      profileId: 'explore',
      task: 'inspect runtime',
      workingDirectory: workspace,
      isolation: 'readonly',
      ...overrides
    }
  }

  function invocationRef() {
    return {
      sessionId: parentSessionId,
      runId: 'run-parent',
      messageId: 'msg-parent',
      toolCallId: 'call-task'
    }
  }

  function createService(options: {
    wait?: Promise<void>
    cancelReleasesWait?: boolean
    scheduler?: SubagentScheduler
    registry?: RunExecutionRegistry
    loadProfile?: (profileId: string) => unknown
    onLinked?: SubagentExecutionServiceDeps['onLinked']
    hostHasArchiveRead?: () => boolean
    childFinalText?: string
  } = {}) {
    const prepareTurn = vi.fn((input: any) => {
      const eventBus = new EventBus()
      let fence = (): boolean => false
      let cancelled = false
      let releaseCancellation!: () => void
      const cancellation = new Promise<void>((resolveCancellation) => {
        releaseCancellation = resolveCancellation
      })
      const agentLoop = {
        setExecutionIdentity: vi.fn(),
        setExecutionFence: vi.fn((next: () => boolean) => { fence = next }),
        cancel: vi.fn(() => {
          cancelled = true
          releaseCancellation()
        }),
        dispose: vi.fn(),
        sendMessage: vi.fn(async () => {
          expect(fence()).toBe(true)
          eventBus.emit({ type: 'message_start', messageId: 'msg-child-final' })
          if (options.wait) {
            if (options.cancelReleasesWait) {
              await Promise.race([options.wait, cancellation])
              if (cancelled) return { status: 'cancelled' }
            } else {
              await options.wait
            }
          }
          const appended = sessionStore.appendMessageFast(input.childSession.id, {
            id: 'msg-child-final',
            role: 'assistant',
            content: options.childFinalText ?? 'child summary',
            toolCalls: [{
              id: 'read-1',
              name: 'read',
              arguments: '{}',
              artifactId: 'artifact-1'
            }],
            timestamp: Date.now()
          })
          expect(appended.ok).toBe(true)
          eventBus.emit({
            type: 'message_end',
            messageId: 'msg-child-final',
            interrupted: false
          })
          return { status: 'completed' }
        })
      } as unknown as AgentLoop
      return { agentLoop, eventBus }
    })
    const scheduler = options.scheduler ?? new SubagentScheduler({ globalLimit: 4, perRootLimit: 3 })
    const registry = options.registry ?? new RunExecutionRegistry()
    const service = new SubagentExecutionService({
      sessionStore,
      runCoordinator: coordinator,
      turnExecutor: new AgentTurnExecutor(
        coordinator,
        registry
      ),
      scheduler,
      isRunExecutionActive: (runId) => registry.get(runId) !== null,
      loadProfile: options.loadProfile ?? ((profileId) => {
        if (profileId === 'explore') return profile
        if (profileId === 'code') {
          return {
            name: 'code',
            description: 'workspace writer',
            allowedTools: ['read', 'write'],
            prompt: 'implement changes',
            maxToolRounds: 30
          }
        }
        return undefined
      }),
      prepareTurn,
      ...(options.hostHasArchiveRead
        ? { hostHasArchiveRead: options.hostHasArchiveRead }
        : {}),
      ...(options.onLinked ? { onLinked: options.onLinked } : {})
    })
    return { service, prepareTurn, scheduler }
  }

  it('创建 durable Child Session 与预分配 child run，并投影最终结果', async () => {
    const { service, prepareTurn } = createService()
    const spawnCommand = command()
    const expectedIdentity = createSpawnIdentity(spawnCommand)

    const execution = await service.spawn(spawnCommand, {
      invocationRef: invocationRef()
    })

    expect(execution).toEqual({
      childSessionId: expect.stringMatching(/^sess_sub_[0-9a-f]{32}$/),
      childRunId: expectedIdentity.spawnRunId,
      status: 'completed',
      summary: 'child summary',
      artifactIds: ['artifact-1'],
      startedAt: expect.any(Number),
      completedAt: expect.any(Number)
    })
    const child = sessionStore.load(execution.childSessionId)
    expect(child).toEqual(expect.objectContaining({
      kind: 'subagent',
      workspaceRoot: workspace,
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'inspect runtime' }),
        expect.objectContaining({ role: 'assistant', content: 'child summary' })
      ])
    }))
    if (child?.kind !== 'subagent') throw new Error('expected Child Session')
    expect(child.subagent.lineage).toEqual(expect.objectContaining({
      parentSessionId,
      parentRunId: 'run-parent',
      rootRunId: 'run-parent',
      depth: 1,
      spawnRunId: expectedIdentity.spawnRunId
    }))
    expect(child.subagent.profile.systemPrompt).toBe('inspect and summarize')
    expect(coordinator.getSnapshot(execution.childRunId)?.status).toBe('completed')
    expect(prepareTurn).toHaveBeenCalledTimes(1)
  })

  it('命令携带 resultSchema 时结果含完整结构化结果，摘要仍有界', async () => {
    const plan = {
      version: 1,
      goal: '完成用户请求',
      tasks: Array.from({ length: 120 }, (_, index) => ({
        id: `task-${index}`,
        title: `任务 ${index}`,
        acceptance: ['x'.repeat(60)]
      }))
    }
    const childFinalText = [
      `已完成规划，共 ${plan.tasks.length} 个任务。`,
      '```json',
      JSON.stringify(plan, null, 2),
      '```'
    ].join('\n')
    expect(childFinalText.length).toBeGreaterThan(MAX_SUBAGENT_SUMMARY_CHARS)
    const { service } = createService({ childFinalText })

    const execution = await service.spawn(
      command({ resultSchema: { type: 'object', required: ['version', 'goal', 'tasks'] } }),
      { invocationRef: invocationRef() }
    )

    expect(execution.status).toBe('completed')
    expect(execution.structuredResult).toEqual(plan)
    expect(execution.summary).toHaveLength(MAX_SUBAGENT_SUMMARY_CHARS)
  })

  it('命令未携带 resultSchema 时不产出结构化结果', async () => {
    const { service } = createService({ childFinalText: '```json\n{"a":1}\n```' })

    const execution = await service.spawn(command(), { invocationRef: invocationRef() })

    expect(execution.structuredResult).toBeUndefined()
  })

  it('宿主有 archive_read 时 prepareTurn 收到含该工具的执行 profile', async () => {
    const { service, prepareTurn } = createService({
      hostHasArchiveRead: () => true
    })
    await service.spawn(command(), { invocationRef: invocationRef() })
    expect(prepareTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          toolNames: expect.arrayContaining(['read', 'grep', 'archive_read'])
        })
      })
    )
  })

  it('宿主无 archive_read 时 prepareTurn 的执行 profile 不含该工具', async () => {
    const { service, prepareTurn } = createService({
      hostHasArchiveRead: () => false,
      loadProfile: () => ({
        name: 'explore',
        description: 'read only exploration',
        allowedTools: ['read', 'grep', 'archive_read'],
        prompt: 'inspect and summarize',
        maxToolRounds: 20
      })
    })
    await service.spawn(command(), { invocationRef: invocationRef() })
    const preparedProfile = prepareTurn.mock.calls[0][0].profile
    expect(preparedProfile.toolNames).toEqual(['read', 'grep'])
    expect(preparedProfile.toolNames).not.toContain('archive_read')
  })

  it('relation 首次持久化后通知 host，幂等重放不伪造新 relation', async () => {
    const onLinked = vi.fn()
    const { service } = createService({ onLinked })

    await service.spawn(command(), { invocationRef: invocationRef() })
    await service.spawn(command(), { invocationRef: invocationRef() })

    expect(onLinked).toHaveBeenNthCalledWith(1, expect.objectContaining({ created: true }))
    expect(onLinked).toHaveBeenNthCalledWith(2, expect.objectContaining({ created: false }))
  })

  it('同一 spawnKey 的并发调用连接同一 promise，终态重放不重复模型执行', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolveWait) => { release = resolveWait })
    const { service, prepareTurn } = createService({ wait })
    const spawnCommand = command()
    const context = { invocationRef: invocationRef() }

    const first = service.spawn(spawnCommand, context)
    const second = service.spawn(spawnCommand, context)
    expect(first).toBe(second)
    await expect(service.spawn({ ...spawnCommand, task: 'conflicting task' }, context))
      .rejects.toThrow(/metadata 冲突/)
    release()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)
    expect(prepareTurn).toHaveBeenCalledTimes(1)

    const replayed = await service.spawn(spawnCommand, context)
    expect(replayed).toEqual(firstResult)
    expect(prepareTurn).toHaveBeenCalledTimes(1)
    expect(sessionStore.list().filter((item) => item.kind === 'subagent')).toHaveLength(1)
  })

  it('全局 profile 修改后终态重放仍使用 Child Session 中的冻结快照', async () => {
    let currentPrompt = 'original frozen prompt'
    const { service, prepareTurn } = createService({
      loadProfile: () => ({ ...profile, prompt: currentPrompt })
    })
    const spawnCommand = command()
    const context = { invocationRef: invocationRef() }
    const first = await service.spawn(spawnCommand, context)
    currentPrompt = 'new global prompt'

    const replayed = await service.spawn(spawnCommand, context)

    expect(replayed).toEqual(first)
    expect(prepareTurn).toHaveBeenCalledTimes(1)
    const child = sessionStore.load(first.childSessionId)
    expect(child?.kind).toBe('subagent')
    if (child?.kind === 'subagent') {
      expect(child.subagent.profile.systemPrompt).toBe('original frozen prompt')
    }
  })

  it('调用身份、parent identity、profile 与已有 metadata 冲突均 fail closed', async () => {
    const { service } = createService()
    await expect(service.spawn(command(), {
      invocationRef: { ...invocationRef(), toolCallId: 'other-call' }
    })).rejects.toThrow(/调用身份/)
    await expect(service.spawn(command({ parentRunId: 'missing-run' }), {
      invocationRef: { ...invocationRef(), runId: 'missing-run' }
    })).rejects.toThrow(/parent session\/run identity/)
    await expect(service.spawn(command({ profileId: 'unknown' }), {
      invocationRef: invocationRef()
    })).rejects.toThrow(/未知子代理类型/)

    await service.spawn(command(), { invocationRef: invocationRef() })
    await expect(service.spawn(command({ task: 'different task' }), {
      invocationRef: invocationRef()
    })).rejects.toThrow(/冲突/)
  })

  it('slash skill fork 绑定 parent message 并持久化唯一 skill roots profile', async () => {
    const skillRoot = resolve(workspace, 'skills', 'inspect')
    const skillCommand: SpawnSubagentCommand = {
      ...command(),
      invocation: {
        kind: 'skill_fork',
        parentMessageId: 'msg-parent',
        skillName: 'inspect'
      },
      profileId: 'skill:inspect'
    }
    const dynamicProfile = {
      name: 'skill:inspect',
      description: 'read skill references',
      prompt: 'inspect using the selected skill',
      allowedTools: ['read'],
      skillRoots: [skillRoot]
    }
    const { service, prepareTurn } = createService()

    const result = await service.spawn(skillCommand, { profile: dynamicProfile })

    const child = sessionStore.load(result.childSessionId)
    expect(child?.kind).toBe('subagent')
    if (child?.kind !== 'subagent') throw new Error('expected Child Session')
    expect(child.subagent.lineage.origin).toEqual(skillCommand.invocation)
    expect(child.subagent.profile.skillRoots).toEqual([skillRoot])
    expect(prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({ skillRoots: [skillRoot] })
    }))

    await expect(service.spawn({
      ...skillCommand,
      invocation: { ...skillCommand.invocation, parentMessageId: 'forged-message' }
    }, { profile: dynamicProfile })).rejects.toThrow(/消息身份/)
  })

  it('非 skill fork 与相对路径 skill roots 均在执行前 fail closed', async () => {
    const { service, prepareTurn } = createService()
    const taskProfile = { ...profile, skillRoots: [resolve(workspace, 'skills', 'bad')] }
    await expect(service.spawn(command(), {
      invocationRef: invocationRef(),
      profile: taskProfile
    })).rejects.toThrow(/只有 skill_fork/)

    await expect(service.spawn({
      ...command(),
      invocation: {
        kind: 'skill_fork',
        parentMessageId: 'msg-parent',
        skillName: 'relative'
      },
      profileId: 'skill:relative'
    }, {
      profile: {
        name: 'skill:relative',
        description: 'invalid root',
        prompt: 'inspect',
        allowedTools: ['read'],
        skillRoots: ['relative/path']
      }
    })).rejects.toThrow(/绝对路径/)
    expect(prepareTurn).not.toHaveBeenCalled()
  })

  it('父信号已取消时仍持久化 child run cancelled，且不装配 AgentLoop', async () => {
    const controller = new AbortController()
    controller.abort()
    const { service, prepareTurn } = createService()

    const execution = await service.spawn(command(), {
      invocationRef: invocationRef(),
      abortSignal: controller.signal
    })

    expect(execution.status).toBe('cancelled')
    expect(coordinator.getSnapshot(execution.childRunId)?.status).toBe('cancelled')
    expect(prepareTurn).not.toHaveBeenCalled()
    expect(sessionStore.load(execution.childSessionId)?.kind).toBe('subagent')
  })

  it('depth 超限与 read_only 父级权限提升请求均被服务拒绝', async () => {
    const readOnlySnapshot = resolveSubagentProfileSnapshot(profile, 'explore')
    const nestedParent = sessionStore.createChildIfAbsent({
      workspaceRoot: workspace,
      mode: 'plan',
      task: 'nested parent',
      subagent: {
        lineage: {
          parentSessionId,
          parentRunId: 'run-parent',
          rootRunId: 'run-parent',
          depth: 1,
          spawnKey: 'nested-parent-key',
          spawnRunId: 'run-nested-parent',
          origin: {
            kind: 'task_tool',
            parentMessageId: 'msg-parent',
            parentToolCallId: 'call-parent-nested'
          }
        },
        profile: readOnlySnapshot
      }
    }).session
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-nested-parent',
      workspaceId: workspace,
      sessionId: nestedParent.id
    })
    coordinator.markRunning('run-nested-parent', 'msg-nested')
    coordinator.bindExecutionGeneration('run-nested-parent', 51)

    const { service } = createService()
    const nestedCommand: SpawnSubagentCommand = {
      parentSessionId: nestedParent.id,
      parentRunId: 'run-nested-parent',
      invocation: {
        kind: 'task_tool',
        parentMessageId: 'msg-nested',
        parentToolCallId: 'call-nested'
      },
      profileId: 'code',
      task: 'attempt write',
      workingDirectory: workspace,
      isolation: 'shared'
    }
    const nestedRef = {
      sessionId: nestedParent.id,
      runId: 'run-nested-parent',
      messageId: 'msg-nested',
      toolCallId: 'call-nested'
    }
    await expect(service.spawn(nestedCommand, {
      invocationRef: nestedRef
    })).rejects.toThrow(/read_only/)

    const codeSnapshot = resolveSubagentProfileSnapshot({
      name: 'code',
      description: 'workspace writer',
      allowedTools: ['read', 'write'],
      prompt: 'implement changes',
      maxToolRounds: 30
    }, 'code')
    const depthTwo = sessionStore.createChildIfAbsent({
      workspaceRoot: workspace,
      mode: 'default',
      task: 'depth two parent',
      subagent: {
        lineage: {
          ...nestedParent.subagent.lineage,
          depth: 2,
          spawnKey: 'depth-two-parent-key',
          spawnRunId: 'run-depth-two-parent'
        },
        profile: codeSnapshot
      }
    }).session
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-depth-two-parent',
      workspaceId: workspace,
      sessionId: depthTwo.id
    })
    coordinator.markRunning('run-depth-two-parent', 'msg-depth-two')
    coordinator.bindExecutionGeneration('run-depth-two-parent', 61)
    await expect(service.spawn({
      ...nestedCommand,
      parentSessionId: depthTwo.id,
      parentRunId: 'run-depth-two-parent',
      profileId: 'explore',
      invocation: {
        kind: 'task_tool',
        parentMessageId: 'msg-depth-two',
        parentToolCallId: 'call-depth-three'
      }
    }, {
      invocationRef: {
        sessionId: depthTwo.id,
        runId: 'run-depth-two-parent',
        messageId: 'msg-depth-two',
        toolCallId: 'call-depth-three'
      }
    })).rejects.toThrow(/超过上限/)
  })

  it('crash window 中 Child Session 已存在但 run 未启动时复用预分配 runId', async () => {
    const spawnCommand = command()
    const identity = createSpawnIdentity(spawnCommand)
    sessionStore.createChildIfAbsent({
      workspaceRoot: workspace,
      mode: 'plan',
      task: spawnCommand.task,
      subagent: {
        lineage: {
          parentSessionId,
          parentRunId: 'run-parent',
          rootRunId: 'run-parent',
          depth: 1,
          spawnKey: identity.spawnKey,
          spawnRunId: identity.spawnRunId,
          origin: spawnCommand.invocation
        },
        profile: resolveSubagentProfileSnapshot(profile, 'explore')
      }
    })
    const { service, prepareTurn } = createService()

    const result = await service.spawn(spawnCommand, { invocationRef: invocationRef() })

    expect(result.childRunId).toBe(identity.spawnRunId)
    expect(result.status).toBe('completed')
    expect(prepareTurn).toHaveBeenCalledTimes(1)
    expect(sessionStore.list().filter((item) => item.kind === 'subagent')).toHaveLength(1)
  })

  it('interrupted child 显式进入 resuming 后复用同一 run，不重复 spawn', async () => {
    const spawnCommand = command()
    const identity = createSpawnIdentity(spawnCommand)
    const child = sessionStore.createChildIfAbsent({
      workspaceRoot: workspace,
      mode: 'plan',
      task: spawnCommand.task,
      subagent: {
        lineage: {
          parentSessionId,
          parentRunId: 'run-parent',
          rootRunId: 'run-parent',
          depth: 1,
          spawnKey: identity.spawnKey,
          spawnRunId: identity.spawnRunId,
          origin: spawnCommand.invocation
        },
        profile: resolveSubagentProfileSnapshot(profile, 'explore')
      }
    }).session
    coordinator.startRun({
      kind: 'agent',
      runId: identity.spawnRunId,
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.markRunning(identity.spawnRunId, 'msg-before-crash')
    coordinator.recordToolPhase(
      identity.spawnRunId,
      'write-before-crash',
      'write',
      'executing',
      { idempotent: false }
    )
    coordinator.commitTerminal({
      runId: identity.spawnRunId,
      status: 'interrupted',
      reason: 'process_exit'
    })
    const { service, prepareTurn } = createService()

    const result = await service.spawn(spawnCommand, { invocationRef: invocationRef() })

    expect(result.status).toBe('completed')
    expect(result.childRunId).toBe(identity.spawnRunId)
    expect(prepareTurn).toHaveBeenCalledTimes(1)
    const prepared = prepareTurn.mock.results[0]?.value as { agentLoop: AgentLoop }
    expect(prepared.agentLoop.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('禁止自动重放的未提交非幂等步骤：write:write-before-crash'),
      expect.anything()
    )
    expect(sessionStore.list().filter((item) => item.kind === 'subagent')).toHaveLength(1)
  })

  it('metadata 与 run parent identity 冲突时 fail closed 并写 durable diagnostic', async () => {
    const spawnCommand = command()
    const identity = createSpawnIdentity(spawnCommand)
    const otherSessionId = sessionStore.create(workspace).id
    coordinator.startRun({
      kind: 'agent',
      runId: identity.spawnRunId,
      workspaceId: workspace,
      sessionId: otherSessionId
    })
    coordinator.markRunning(identity.spawnRunId)
    const { service } = createService()

    await expect(service.spawn(spawnCommand, { invocationRef: invocationRef() }))
      .rejects.toThrow(/metadata 冲突/)
    expect(coordinator.getSnapshot(identity.spawnRunId)?.progress?.extras)
      .toEqual(expect.objectContaining({ diagnosticCode: 'subagent_identity_conflict' }))
  })

  it('timeout 会真正 cancel AgentLoop 并以 timeout failure 收敛，permit 同步释放', async () => {
    const never = new Promise<void>(() => {})
    const { service, prepareTurn, scheduler } = createService({ wait: never, cancelReleasesWait: true })

    const result = await service.spawn(command({ timeoutMs: 1 }), {
      invocationRef: invocationRef()
    })

    expect(result).toEqual(expect.objectContaining({
      status: 'failed',
      failure: expect.objectContaining({ code: 'timeout' })
    }))
    const prepared = prepareTurn.mock.results[0]?.value as { agentLoop: AgentLoop }
    expect(prepared.agentLoop.cancel).toHaveBeenCalled()
    expect(scheduler.snapshot().activeGlobal).toBe(0)
  })

  it('interrupted resume 无 permit 时保持 interrupted，不留下假 resuming', async () => {
    const spawnCommand = command()
    const identity = createSpawnIdentity(spawnCommand)
    const child = sessionStore.createChildIfAbsent({
      workspaceRoot: workspace,
      mode: 'plan',
      task: spawnCommand.task,
      subagent: {
        lineage: {
          parentSessionId,
          parentRunId: 'run-parent',
          rootRunId: 'run-parent',
          depth: 1,
          spawnKey: identity.spawnKey,
          spawnRunId: identity.spawnRunId,
          origin: spawnCommand.invocation
        },
        profile: resolveSubagentProfileSnapshot(profile, 'explore')
      }
    }).session
    coordinator.startRun({
      kind: 'agent',
      runId: identity.spawnRunId,
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.markRunning(identity.spawnRunId)
    coordinator.commitTerminal({ runId: identity.spawnRunId, status: 'interrupted' })
    const scheduler = new SubagentScheduler({ globalLimit: 1, perRootLimit: 1 })
    const occupied = await scheduler.acquire({
      runId: 'run-occupied',
      rootRunId: 'run-parent',
      requestKey: 'occupied'
    })
    const { service } = createService({ scheduler })

    await expect(service.spawn(spawnCommand, { invocationRef: invocationRef() }))
      .rejects.toMatchObject({
        name: 'SubagentScheduleRejectedError',
        rejection: expect.objectContaining({ code: 'global_limit' })
      })
    expect(coordinator.getSnapshot(identity.spawnRunId)?.status).toBe('interrupted')
    if (occupied.ok) occupied.permit.release()
  })

  it('首次 spawn 被调度器拒绝时写入 terminal run，不留下 record_missing 子会话', async () => {
    const scheduler = new SubagentScheduler({ globalLimit: 1, perRootLimit: 1 })
    const occupied = await scheduler.acquire({
      runId: 'run-occupied',
      rootRunId: 'run-parent',
      requestKey: 'occupied'
    })
    const spawnCommand = command()
    const identity = createSpawnIdentity(spawnCommand)
    const { service } = createService({ scheduler })

    const result = await service.spawn(spawnCommand, { invocationRef: invocationRef() })

    expect(result).toEqual(expect.objectContaining({
      childRunId: identity.spawnRunId,
      status: 'failed',
      failure: expect.objectContaining({ code: 'scheduler' })
    }))
    expect(coordinator.getSnapshot(identity.spawnRunId)?.status).toBe('failed')
    if (occupied.ok) occupied.permit.release()
  })

  it('同一 stable childRunId 已由其他服务持有 permit 时无副作用地结构化拒绝', async () => {
    const scheduler = new SubagentScheduler({ globalLimit: 2, perRootLimit: 2 })
    const spawnCommand = command()
    const identity = createSpawnIdentity(spawnCommand)
    const authoritative = await scheduler.acquire({
      runId: identity.spawnRunId,
      rootRunId: 'run-parent',
      requestKey: 'authoritative-service'
    })
    if (!authoritative.ok) throw new Error('expected permit')
    const { service } = createService({ scheduler })

    await expect(service.spawn(spawnCommand, { invocationRef: invocationRef() }))
      .rejects.toMatchObject({
        name: 'SubagentScheduleRejectedError',
        rejection: expect.objectContaining({ code: 'run_active' })
      })
    expect(coordinator.getSnapshot(identity.spawnRunId)).toBeNull()

    authoritative.permit.release()
  })

  it('两个服务实例竞争同一 command 时不会把权威执行的 Run 改写为失败', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolveWait) => { release = resolveWait })
    const scheduler = new SubagentScheduler({ globalLimit: 2, perRootLimit: 2 })
    const registry = new RunExecutionRegistry()
    const firstHost = createService({ wait, scheduler, registry })
    const secondHost = createService({ scheduler, registry })
    const spawnCommand = command()
    const identity = createSpawnIdentity(spawnCommand)

    const first = firstHost.service.spawn(spawnCommand, { invocationRef: invocationRef() })
    await vi.waitFor(() => expect(firstHost.prepareTurn).toHaveBeenCalledTimes(1))
    await expect(secondHost.service.spawn(spawnCommand, { invocationRef: invocationRef() }))
      .rejects.toThrow(`child run ${identity.spawnRunId} 已有活跃执行句柄`)

    expect(coordinator.getSnapshot(identity.spawnRunId)?.status).toBe('running')
    release()
    await expect(first).resolves.toEqual(expect.objectContaining({ status: 'completed' }))
    expect(coordinator.getSnapshot(identity.spawnRunId)?.status).toBe('completed')
  })
})
