import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentProjectionService } from '../../../src/main/agent/subagents'
import { createRunCoordinator } from '../../../src/runtime/run'
import { SessionStore } from '../../../src/runtime/sessions'
import { writeManifest, getFilesDir } from '../../../src/runtime/checkpoints/manifest'
import type { SubagentSessionMetadata } from '../../../src/shared/subagents'

describe('SubagentProjectionService', () => {
  let tempRoot: string
  let workspace: string
  let sessionStore: SessionStore
  let coordinator: ReturnType<typeof createRunCoordinator>
  let parentSessionId: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'nova-subagent-projection-'))
    workspace = resolve(tempRoot, 'workspace')
    sessionStore = new SessionStore(tempRoot)
    coordinator = createRunCoordinator(join(tempRoot, 'runs'))
    parentSessionId = sessionStore.create(workspace).id
  })

  afterEach(() => rmSync(tempRoot, { recursive: true, force: true }))

  function createChild(
    toolCallId: string,
    spawnRunId: string,
    profileModel?: { providerId: string; modelId: string }
  ) {
    const metadata: SubagentSessionMetadata = {
      lineage: {
        parentSessionId,
        parentRunId: 'run-parent',
        rootRunId: 'run-parent',
        depth: 1,
        spawnKey: `task_tool:${toolCallId}`,
        spawnRunId,
        origin: {
          kind: 'task_tool',
          parentMessageId: 'msg-parent',
          parentToolCallId: toolCallId
        }
      },
      profile: {
        profileId: 'explore',
        name: 'Explore',
        description: 'inspect',
        systemPrompt: 'secret prompt',
        toolNames: ['read'],
        permissionCeiling: 'read_only',
        maxToolRounds: 20,
        configHash: 'hash',
        ...(profileModel ? { model: profileModel } : {})
      }
    }
    return sessionStore.createChildIfAbsent({
      workspaceRoot: workspace,
      mode: 'plan',
      permissionMode: 'request_approval',
      task: 'inspect runtime',
      subagent: metadata
    }).session
  }

  function createWorkflowChild(toolCallId: string, spawnRunId: string) {
    const metadata: SubagentSessionMetadata = {
      lineage: {
        parentSessionId,
        parentRunId: 'run-parent',
        rootRunId: 'run-parent',
        depth: 1,
        spawnKey: `workflow:${toolCallId}`,
        spawnRunId,
        origin: {
          kind: 'workflow',
          workflowRunId: 'workflow-run',
          phase: 'research',
          parentMessageId: 'msg-parent',
          parentToolCallId: toolCallId,
          taskId: 'question-a',
          batchId: 'research-0',
          occurrence: 1
        }
      },
      profile: {
        profileId: 'workflow-readonly',
        name: 'Workflow Researcher',
        description: 'inspect',
        systemPrompt: 'secret prompt',
        toolNames: ['read'],
        permissionCeiling: 'read_only',
        maxToolRounds: 20,
        configHash: 'workflow-hash'
      }
    }
    return sessionStore.createChildIfAbsent({
      workspaceRoot: workspace,
      mode: 'compose',
      permissionMode: 'request_approval',
      task: 'research question',
      subagent: metadata
    }).session
  }

  it('从 durable session 与 run 重建父工具投影且不泄露 profile 配置', () => {
    const child = createChild('call-1', 'run-child-1')
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-child-1',
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.markRunning('run-child-1', 'msg-final')
    sessionStore.appendMessageFast(child.id, {
      id: 'msg-final',
      role: 'assistant',
      content: 'bounded child summary',
      toolCalls: [{
        id: 'tool-1',
        name: 'read',
        arguments: '{}',
        artifactId: 'artifact-1'
      }],
      timestamp: Date.now()
    })
    coordinator.commitTerminal({ runId: 'run-child-1', status: 'completed' })

    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })
    const projection = service.getByParentToolCallId(parentSessionId, 'call-1')

    expect(projection).toMatchObject({
      childSessionId: child.id,
      childRunId: 'run-child-1',
      parentSessionId,
      parentToolCallId: 'call-1',
      status: 'completed',
      summary: 'bounded child summary',
      artifactCount: 1,
      profile: {
        profileId: 'explore',
        name: 'Explore',
        permissionCeiling: 'read_only'
      }
    })
    expect(projection?.profile).not.toHaveProperty('systemPrompt')
    expect(projection?.profile).not.toHaveProperty('toolNames')
  })

  it('被截断的 child 经 durable 记录投影为未完成摘要（第二投影点防漂移）', () => {
    const child = createChild('call-trunc', 'run-child-trunc')
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-child-trunc',
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.markRunning('run-child-trunc', 'msg-final')
    sessionStore.appendMessageFast(child.id, {
      id: 'msg-final',
      role: 'assistant',
      content: 'partial progress text',
      timestamp: Date.now()
    })
    coordinator.commitTerminal({
      runId: 'run-child-trunc',
      status: 'completed',
      incompleteReason: 'max_rounds'
    })

    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })
    const projection = service.getByParentToolCallId(parentSessionId, 'call-trunc')

    // activity 状态是 RunStatus 投影（completed 不变）；摘要来自 execution 投影
    expect(projection).toMatchObject({
      childRunId: 'run-child-trunc',
      status: 'completed',
      summary: 'partial progress text'
    })
    expect(projection).not.toHaveProperty('failure')
  })

  it('Child Session 存在但 run 缺失时显式返回 record_missing', () => {
    const child = createChild('call-missing', 'run-missing')
    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })

    expect(service.listByParentSessionId(parentSessionId)).toEqual([
      expect.objectContaining({
        childSessionId: child.id,
        childRunId: 'run-missing',
        status: 'record_missing'
      })
    ])
  })

  it('Workflow child 投影保留阶段与稳定 batch item 身份', () => {
    const child = createWorkflowChild('workflow-tool', 'run-workflow-child')
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-workflow-child',
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.markRunning('run-workflow-child', 'msg-workflow-child')

    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })
    const projection = service.getByChildSessionId(child.id)

    expect(projection).toEqual(expect.objectContaining({
      parentToolCallId: 'workflow-tool',
      workflow: {
        workflowRunId: 'workflow-run',
        phase: 'research',
        taskId: 'question-a',
        batchId: 'research-0',
        occurrence: 1
      }
    }))
  })

  it('启动批量轻投影只扫一次 metadata，不读取终态 transcript', () => {
    const child = createChild('call-light', 'run-light')
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-light',
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.markRunning('run-light', 'msg-light')
    coordinator.commitTerminal({ runId: 'run-light', status: 'completed' })
    const listInternal = vi.spyOn(sessionStore, 'listInternal')
    const load = vi.spyOn(sessionStore, 'load')

    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })
    const projections = service.listLightweightByParentSessionIds([parentSessionId])

    expect(listInternal).toHaveBeenCalledTimes(1)
    expect(load).not.toHaveBeenCalled()
    expect(projections).toEqual([
      expect.objectContaining({
        childSessionId: child.id,
        taskLabel: 'inspect runtime',
        status: 'completed'
      })
    ])
    expect(projections[0]).not.toHaveProperty('summary')
  })

  it('interrupted child 的 pending interaction 仍从父行投影为等待授权', () => {
    const child = createChild('call-waiting', 'run-child-waiting')
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-child-waiting',
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.markRunning('run-child-waiting', 'msg-child')
    coordinator.inbox.enqueue({
      runId: 'run-child-waiting',
      sessionId: child.id,
      messageId: 'msg-child',
      type: 'permission',
      interactionId: 'permission-child',
      payload: { requestId: 'permission-child' }
    })
    coordinator.commitTerminal({
      runId: 'run-child-waiting',
      status: 'interrupted',
      reason: 'process_exit'
    })

    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })
    const projection = service.getByChildSessionId(child.id)

    expect(projection).toEqual(expect.objectContaining({
      status: 'waiting_user',
      latestActivity: '等待你的授权'
    }))
  })

  it('model 继承父会话活跃模型，profile.model 覆盖优先', () => {
    const child = createChild('call-model', 'run-child-model')
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-child-model',
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.markRunning('run-child-model', 'msg-child')
    coordinator.commitTerminal({ runId: 'run-child-model', status: 'completed' })

    const service = new SubagentProjectionService({
      sessionStore,
      runCoordinator: coordinator,
      resolveParentModel: () => ({ providerId: 'parent-provider', modelId: 'parent-model' })
    })
    expect(service.getByParentToolCallId(parentSessionId, 'call-model')?.model).toEqual({
      providerId: 'parent-provider',
      modelId: 'parent-model'
    })

    const overridden = createChild('call-override', 'run-child-override', {
      providerId: 'profile-provider',
      modelId: 'profile-model'
    })
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-child-override',
      workspaceId: workspace,
      sessionId: overridden.id
    })
    coordinator.commitTerminal({ runId: 'run-child-override', status: 'completed' })

    const projection = service.getByParentToolCallId(parentSessionId, 'call-override')
    expect(projection?.model).toEqual({
      providerId: 'profile-provider',
      modelId: 'profile-model'
    })
    // 对外 profile 投影不携带 model（model 只出现在投影顶层）
    expect(projection?.profile).not.toHaveProperty('model')
  })

  it('model 无法推导时省略字段；profile 投影保持窄形状', () => {
    const child = createChild('call-no-model', 'run-no-model')
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-no-model',
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.commitTerminal({ runId: 'run-no-model', status: 'completed' })

    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })
    const projection = service.getByParentToolCallId(parentSessionId, 'call-no-model')

    expect(projection).not.toHaveProperty('model')
  })

  it('reasoningEffort 继承父会话覆盖；无覆盖时省略', () => {
    const child = createChild('call-effort', 'run-child-effort')
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-child-effort',
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.commitTerminal({ runId: 'run-child-effort', status: 'completed' })

    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })
    expect(service.getByParentToolCallId(parentSessionId, 'call-effort')).not.toHaveProperty(
      'reasoningEffort'
    )

    sessionStore.updateReasoningEffortOverride(parentSessionId, 'high')
    expect(service.getByParentToolCallId(parentSessionId, 'call-effort')).toMatchObject({
      reasoningEffort: 'high'
    })
  })

  it('终态且有 checkpoint 改动时投影输出 fileChanges（逐文件增删行数）', () => {
    const child = createChild('call-files', 'run-child-files')
    // SessionStore 的会话与 checkpoint 都挂在 <appDataPath>/sessions 下
    const sessionRoot = join(tempRoot, 'sessions')
    const backupPath = resolve(getFilesDir(sessionRoot, child.id, 'msg-child'), 'src', 'a.ts')
    mkdirSync(join(backupPath, '..'), { recursive: true })
    writeFileSync(backupPath, 'old line', 'utf-8')
    const workspaceFile = join(workspace, 'src', 'a.ts')
    mkdirSync(join(workspaceFile, '..'), { recursive: true })
    writeFileSync(workspaceFile, 'new line\nsecond line', 'utf-8')
    writeManifest(sessionRoot, {
      sessionId: child.id,
      messageId: 'msg-child',
      workspaceRoot: workspace,
      createdFiles: [],
      modifiedFiles: ['src/a.ts'],
      deletedFiles: [],
      status: 'active',
      createdAt: Date.now()
    })
    sessionStore.appendMessageFast(child.id, {
      id: 'msg-child',
      role: 'assistant',
      content: 'done',
      timestamp: Date.now()
    })
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-child-files',
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.markRunning('run-child-files', 'msg-child')
    coordinator.commitTerminal({ runId: 'run-child-files', status: 'completed' })

    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })
    const projection = service.getByParentToolCallId(parentSessionId, 'call-files')

    expect(projection?.fileChanges).toEqual([
      {
        filePath: 'src/a.ts',
        status: 'modified',
        addedLines: 2,
        removedLines: 1
      }
    ])
  })

  it('终态但无 checkpoint 且只读子代理不输出 fileChanges', () => {
    const child = createChild('call-no-files', 'run-no-files')
    sessionStore.appendMessageFast(child.id, {
      id: 'msg-child',
      role: 'assistant',
      content: 'read only summary',
      timestamp: Date.now()
    })
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-no-files',
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.markRunning('run-no-files', 'msg-child')
    coordinator.commitTerminal({ runId: 'run-no-files', status: 'completed' })

    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })
    const projection = service.getByParentToolCallId(parentSessionId, 'call-no-files')

    expect(projection?.status).toBe('completed')
    expect(projection).not.toHaveProperty('fileChanges')
  })

  it('轻投影不读取终态 transcript，也不携带 fileChanges', () => {
    const child = createChild('call-light2', 'run-light2')
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-light2',
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.markRunning('run-light2', 'msg-light2')
    coordinator.commitTerminal({ runId: 'run-light2', status: 'completed' })
    const load = vi.spyOn(sessionStore, 'load')

    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })
    const [projection] = service.listLightweightByParentSessionIds([parentSessionId])

    expect(load).not.toHaveBeenCalled()
    expect(projection).not.toHaveProperty('fileChanges')
    expect(projection).not.toHaveProperty('summary')
  })
})
