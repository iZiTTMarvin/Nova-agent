import { XForgeRunService } from '../../../../../src/runtime/workflow/xforge/XForgeRunService'
import { bindXForgeTestExecution } from './testExecution'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../../../../src/runtime/agent/EventBus'
import { CheckpointManager } from '../../../../../src/runtime/checkpoints/CheckpointManager'
import type { ModelClient } from '../../../../../src/runtime/model/ModelClient'
import type { ChatEvent } from '../../../../../src/runtime/model/types'
import { createRunCoordinator } from '../../../../../src/runtime/run/RunCoordinator'
import { SkillRegistry } from '../../../../../src/runtime/skills/SkillRegistry'
import { ToolRegistry } from '../../../../../src/runtime/tools/ToolRegistry'
import { bashTool } from '../../../../../src/runtime/tools/bashTool'
import { createReadState } from '../../../../../src/runtime/tools/editTool'
import type { ToolExecutor } from '../../../../../src/runtime/tools/types'
import { writeTool } from '../../../../../src/runtime/tools/writeTool'
import {
  runXForgeLiveRuntime
} from '../../../../../src/runtime/workflow/xforge/liveRuntime'
import { XForgeMainAgentSession } from '../../../../../src/runtime/workflow/xforge/mainAgentSession'
import {
  resolveXForgeDeliveryCommands,
  resolveXForgeTaskVerificationCommand
} from '../../../../../src/runtime/workflow/xforge/liveDeliveryHost'
import { normalizeXForgeBrainstormPayload } from '../../../../../src/runtime/workflow/xforge/liveStageHost'
import { classifyXForgeRequest } from '../../../../../src/runtime/workflow/xforge/requestResolution'
import { createInitialXForgeRunState } from '../../../../../src/runtime/workflow/xforge/runState'
import { createTaskStatesFromPlan } from '../../../../../src/runtime/workflow/xforge/plan'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scriptedClient(outputs: Array<string | ChatEvent[]>): ModelClient {
  let index = 0
  return {
    async *chat(): AsyncIterable<ChatEvent> {
      const output = outputs[index++]
      if (output === undefined) throw new Error(`unexpected model call ${index}`)
      if (Array.isArray(output)) {
        for (const event of output) yield event
        return
      }
      yield { type: 'text_delta', delta: output }
      yield { type: 'message_end', finishReason: 'stop' }
    },
    updateConfig() {}
  }
}

function semantic(overrides: Partial<{
  reviewOnly: boolean
  codeReadyForTest: boolean
  isBugfix: boolean
  isVagueNewRequirement: boolean
  isNonDevRequest: boolean
  modelSemanticHint: 'brainstorm' | 'plan'
}> = {}): string {
  return JSON.stringify({
    reviewOnly: false,
    codeReadyForTest: false,
    isBugfix: false,
    isVagueNewRequirement: false,
    isNonDevRequest: false,
    modelSemanticHint: 'plan',
    ...overrides
  })
}

function noopTool(name: string): ToolExecutor {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    executionMode: 'sequential',
    async execute() {
      return { success: true, output: `${name} ok` }
    }
  }
}

describe('XForge live Runtime', () => {
  it('自然语言与显式约束解析到安全起点', () => {
    expect(classifyXForgeRequest('实现一个登录页面').modelSemanticHint).toBeUndefined()
    expect(classifyXForgeRequest('我想加浏览器能力，还没想清楚').isVagueNewRequirement).toBe(true)
    expect(classifyXForgeRequest('我打算优化我的项目，你觉得呢').isVagueNewRequirement).toBe(true)
    expect(classifyXForgeRequest('代码已经改好，只帮我测试').codeReadyForTest).toBe(true)
    expect(classifyXForgeRequest('只审查，不要改代码').reviewOnly).toBe(true)
    expect(classifyXForgeRequest('不要动代码，帮我看看哪里有问题').reviewOnly).toBe(true)
    expect(classifyXForgeRequest('这个页面加载好卡').isBugfix).toBe(true)
    expect(classifyXForgeRequest('/br-full-dev 实现登录', true).requestedStartStage).toBe('brainstorm')
  })

  it('兼容 Runtime 与阶段方法的 brainstorm 产物，并允许澄清态省略 artifact', () => {
    const fallback = {
      goal: '优化博客',
      constraints: ['不改构建流程'],
      nonGoals: ['不做发布'],
      userDecisions: ['中文阅读优先']
    }
    expect(normalizeXForgeBrainstormPayload({
      title: '排版节奏',
      body: '# 中文阅读排版方案',
      route: 'br-brainstorming'
    }, fallback)).toEqual({
      needsMoreClarification: false,
      mainSession: fallback,
      designNotes: ['# 中文阅读排版方案']
    })
    expect(normalizeXForgeBrainstormPayload({
      needsMoreClarification: true,
      mainSession: fallback
    }, fallback)).toEqual({
      needsMoreClarification: true,
      mainSession: fallback,
      designNotes: []
    })
  })

  it('implement 主 Agent 使用 compose mode 但只暴露读写工具 schema', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-effective-tools-'))
    roots.push(root)
    mkdirSync(join(root, '.nova'), { recursive: true })

    const plan = {
      version: 1,
      goal: '收敛权限契约',
      constraints: ['不自动 commit'],
      nonGoals: ['不运行发布动作'],
      repositoryFacts: ['存在 TypeScript 工具链'],
      changeScope: ['src/runtime/workflow/xforge/policy.ts'],
      tasks: [{ id: 'T1', title: '实现 policy', acceptance: ['policy 单测通过'] }],
      acceptanceMap: { T1: ['policy 单测通过'] },
      verificationChecklist: [],
      risks: ['工具 schema 不能与授权口径分裂']
    }

    const observed: Array<{ userText: string; toolNames: string[] }> = []
    const client: ModelClient = {
      async *chat(messages: unknown, tools?: Array<{ name: string }>): AsyncIterable<ChatEvent> {
        const chatMessages = messages as Array<{ role: string; content: string }>
        const lastUser = [...chatMessages].reverse().find(message => message.role === 'user')
        observed.push({
          userText: String(lastUser?.content ?? ''),
          toolNames: tools?.map(tool => tool.name) ?? []
        })
        yield { type: 'text_delta', delta: '无需写入。' }
        yield { type: 'message_end', finishReason: 'stop' }
      },
      updateConfig() {}
    }

    const runsRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-runs-'))
    roots.push(runsRoot)
    const coordinator = createRunCoordinator(runsRoot)
    const service = new XForgeRunService(coordinator)
    const initial = {
      ...createInitialXForgeRunState({
        currentStage: 'implement',
        hasValidatedPlan: true,
        hasValidScopePass: true,
        planVersion: 1,
        scopePass: { planVersion: 1, workspaceRevision: 0 }
      }),
      validatedPlan: plan,
      tasks: createTaskStatesFromPlan(plan)
    }
    const run = service.startXForgeRun({ workspaceId: root, sessionId: 'session-effective-tools', xforge: initial })
    coordinator.markRunning(run.runId)
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-checkpoints-'))
    roots.push(checkpointRoot)
    const checkpointManager = new CheckpointManager({
      checkpointDir: checkpointRoot,
      sessionId: 'session-effective-tools',
      workspaceRoot: root
    })
    const toolRegistry = new ToolRegistry()
    for (const name of ['ls', 'read', 'grep', 'find', 'edit', 'write', 'bash', 'task', 'invoke_skill', 'askQuestion', 'unknown']) {
      toolRegistry.register(noopTool(name))
    }

    await runXForgeLiveRuntime({
      runId: run.runId,
      request: '实现 policy',
      workspaceRoot: root,
      modelClient: client,
      parentEventBus: new EventBus(),
      parentMessageId: 'message-effective-tools',
      toolRegistry,
      skillRegistry: SkillRegistry.load({
        builtinDir: resolve('.nova/skills'),
        globalDir: join(root, '.global-skills'),
        workspaceRoot: root
      }),
      checkpointManager,
      committer: bindXForgeTestExecution(service, coordinator, run.runId),
      initializeWorkspaceBaseline: true,
      askQuestion: vi.fn(async () => []),
      readState: createReadState()
    })

    const implementCall = observed.find(call => call.userText.includes('当前阶段：实施任务 T1'))
    expect(implementCall?.userText).toContain('[当前模式: XForge')
    expect(implementCall?.userText).toContain('主 Agent 永远不能执行 bash、task、invoke_skill 或 askQuestion')
    expect(implementCall?.userText).toContain('测试、验证、用户提问和阶段推进由 Runtime 控制')
    expect(implementCall?.userText).not.toContain('可以读取、修改和验证工作区')
    expect(implementCall?.userText).not.toContain('askQuestion / askUser')
    expect(implementCall?.toolNames).toEqual(['ls', 'read', 'grep', 'find', 'edit', 'write'])
  })

  it('brainstorm 拒绝写入工具，由 Runtime 持久化结构化产物且不污染父正文', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-brainstorm-'))
    roots.push(root)
    mkdirSync(join(root, '.nova'), { recursive: true })

    const plan = {
      plan: {
        version: 1,
        goal: '优化中文阅读排版',
        constraints: ['不改构建流程'],
        nonGoals: ['不做发布'],
        repositoryFacts: ['静态博客'],
        changeScope: ['css/style.css'],
        tasks: [{ id: 'T1', title: '调整排版', acceptance: ['中文长文留白清晰'] }],
        acceptanceMap: { T1: ['中文长文留白清晰'] },
        verificationChecklist: [],
        risks: ['视觉验收需要人工确认']
      }
    }
    const client = scriptedClient([
      semantic({ isVagueNewRequirement: true, modelSemanticHint: 'brainstorm' }),
      JSON.stringify({
        questions: [{
          question: '更关注哪类阅读体验？',
          options: [{ label: '中文长文' }],
          custom: true
        }]
      }),
      [
        { type: 'message_start' },
        { type: 'tool_call_start', toolCallId: 'write-idea', toolName: 'write', index: 0 },
        {
          type: 'tool_call',
          toolCall: {
            id: 'write-idea',
            name: 'write',
            arguments: JSON.stringify({
              path: '.buildrail/idea/typography.md',
              content: '# 中文阅读排版方案'
            })
          }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ],
      JSON.stringify({
        title: '排版节奏',
        body: '# 中文阅读排版方案',
        route: 'br-brainstorming'
      }),
      JSON.stringify(plan),
      JSON.stringify({ findings: [] }),
      '已按任务完成实现。'
    ])
    const runsRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-runs-'))
    roots.push(runsRoot)
    const coordinator = createRunCoordinator(runsRoot)
    const service = new XForgeRunService(coordinator)
    const run = service.startXForgeRun({ workspaceId: root, sessionId: 'session-brainstorm' })
    coordinator.markRunning(run.runId)
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-checkpoints-'))
    roots.push(checkpointRoot)
    const checkpointManager = new CheckpointManager({
      checkpointDir: checkpointRoot,
      sessionId: 'session-brainstorm',
      workspaceRoot: root
    })
    const toolRegistry = new ToolRegistry()
    toolRegistry.register(writeTool)

    const parentEventBus = new EventBus()
    const parentEvents: Array<{ type: string }> = []
    parentEventBus.on(event => parentEvents.push(event))
    const result = await runXForgeLiveRuntime({
      runId: run.runId,
      request: '我想优化博客阅读体验',
      workspaceRoot: root,
      modelClient: client,
      parentEventBus,
      parentMessageId: 'message-brainstorm',
      toolRegistry,
      skillRegistry: SkillRegistry.load({
        builtinDir: resolve('.nova/skills'),
        globalDir: join(root, '.global-skills'),
        workspaceRoot: root
      }),
      checkpointManager,
      committer: bindXForgeTestExecution(service, coordinator, run.runId),
      initializeWorkspaceBaseline: true,
      askQuestion: vi.fn(async () => [{ selectedLabels: ['中文长文'] }]),
      readState: createReadState()
    })

    expect(existsSync(join(root, '.buildrail/idea/typography.md'))).toBe(false)
    expect(result.state.stageArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'brainstorm' })
    ]))
    const brainstormArtifact = result.state.stageArtifacts.find(item => item.stage === 'brainstorm')
    expect(readFileSync(join(root, brainstormArtifact!.path), 'utf8')).toContain('# XForge Exploration')
    expect(parentEvents.some(event => event.type === 'text_delta')).toBe(false)
    expect(result.state.mainSession.userDecisions).toEqual(['中文长文'])
    expect(result.state.currentStage).toBe('waiting_user')
    expect(result.state.waitingReason).toContain('Test Gate 缺少')
  })

  it('plan 拒绝 bash 副作用，并在新鲜无工具上下文修复截断 JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-plan-repair-'))
    roots.push(root)
    mkdirSync(join(root, '.nova'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      scripts: { build: 'node build.js' }
    }))
    const plan = {
      plan: {
        version: 1,
        goal: '优化静态博客',
        constraints: ['保持纯静态'],
        nonGoals: ['不引入后端'],
        repositoryFacts: ['package.json 提供 build script'],
        changeScope: ['build.js'],
        tasks: [{ id: 'T1', title: '实现静态增强', acceptance: ['构建逻辑保持纯静态'] }],
        acceptanceMap: { T1: ['构建逻辑保持纯静态'] },
        verificationChecklist: [],
        risks: ['缺少自动测试']
      }
    }
    const client = scriptedClient([
      semantic(),
      [
        { type: 'message_start' },
        { type: 'tool_call_start', toolCallId: 'plan-bash', toolName: 'bash', index: 0 },
        {
          type: 'tool_call',
          toolCall: {
            id: 'plan-bash',
            name: 'bash',
            arguments: JSON.stringify({
              command: 'Set-Content -LiteralPath forbidden.txt -Value touched'
            })
          }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ],
      '```json\n{"plan":{"version":1',
      JSON.stringify(plan),
      JSON.stringify({ findings: [] }),
      '任务无需写入。'
    ])
    const runsRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-runs-'))
    roots.push(runsRoot)
    const coordinator = createRunCoordinator(runsRoot)
    const service = new XForgeRunService(coordinator)
    const run = service.startXForgeRun({ workspaceId: root, sessionId: 'session-plan-repair' })
    coordinator.markRunning(run.runId)
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-checkpoints-'))
    roots.push(checkpointRoot)
    const toolRegistry = new ToolRegistry()
    toolRegistry.register(bashTool)
    const parentEventBus = new EventBus()
    const parentEvents: Array<{ type: string }> = []
    parentEventBus.on(event => parentEvents.push(event))

    const result = await runXForgeLiveRuntime({
      runId: run.runId,
      request: '优化这个静态博客的功能',
      workspaceRoot: root,
      modelClient: client,
      parentEventBus,
      parentMessageId: 'message-plan-repair',
      toolRegistry,
      skillRegistry: SkillRegistry.load({
        builtinDir: resolve('.nova/skills'),
        globalDir: join(root, '.global-skills'),
        workspaceRoot: root
      }),
      checkpointManager: new CheckpointManager({
        checkpointDir: checkpointRoot,
        sessionId: 'session-plan-repair',
        workspaceRoot: root
      }),
      committer: bindXForgeTestExecution(service, coordinator, run.runId),
      initializeWorkspaceBaseline: true,
      askQuestion: vi.fn(async () => []),
      readState: createReadState()
    })

    expect(existsSync(join(root, 'forbidden.txt'))).toBe(false)
    expect(result.state.currentStage).toBe('waiting_user')
    expect(result.state.validatedPlan?.goal).toBe('优化静态博客')
    const planArtifact = result.state.stageArtifacts.find(item => item.stage === 'plan')
    expect(readFileSync(join(root, planArtifact!.path), 'utf8')).toContain('# XForge Implementation Plan')
    expect(parentEvents.some(event => event.type === 'text_delta')).toBe(false)
  })

  it('结构化结果最终无效时保留真实失败原因，不改写成 Pipeline 泛化错误', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-invalid-brainstorm-'))
    roots.push(root)
    mkdirSync(join(root, '.nova'), { recursive: true })
    const client = scriptedClient([
      semantic({ isVagueNewRequirement: true, modelSemanticHint: 'brainstorm' }),
      JSON.stringify({
        questions: [{ question: '优化重点是什么？', options: [{ label: '阅读体验' }] }]
      }),
      '这不是 JSON',
      '仍然不是 JSON'
    ])
    const runsRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-runs-'))
    roots.push(runsRoot)
    const coordinator = createRunCoordinator(runsRoot)
    const service = new XForgeRunService(coordinator)
    const run = service.startXForgeRun({ workspaceId: root, sessionId: 'session-invalid' })
    coordinator.markRunning(run.runId)
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-checkpoints-'))
    roots.push(checkpointRoot)

    await expect(runXForgeLiveRuntime({
      runId: run.runId,
      request: '我想优化博客阅读体验',
      workspaceRoot: root,
      modelClient: client,
      parentEventBus: new EventBus(),
      parentMessageId: 'message-invalid',
      toolRegistry: new ToolRegistry(),
      skillRegistry: SkillRegistry.load({
        builtinDir: resolve('.nova/skills'),
        globalDir: join(root, '.global-skills'),
        workspaceRoot: root
      }),
      checkpointManager: new CheckpointManager({
        checkpointDir: checkpointRoot,
        sessionId: 'session-invalid',
        workspaceRoot: root
      }),
      committer: bindXForgeTestExecution(service, coordinator, run.runId),
      initializeWorkspaceBaseline: true,
      askQuestion: vi.fn(async () => [{ selectedLabels: ['阅读体验'] }]),
      readState: createReadState()
    })).rejects.toThrow('结构化结果无法通过 JSON 与字段校验')

    const snapshot = coordinator.getSnapshot(run.runId)
    expect(snapshot?.xforge?.currentStage).toBe('failed')
    expect(snapshot?.xforge?.lastTransitionReason).toContain('结构化结果无法通过 JSON 与字段校验')
    expect(snapshot?.xforge?.lastTransitionReason).not.toContain('Pipeline 未进入')
  })

  it('非开发输入在 resolve 阶段完成，不进入计划或实施流水线', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-nondev-'))
    roots.push(root)
    mkdirSync(join(root, '.nova'), { recursive: true })
    const client = scriptedClient([
      semantic({ isNonDevRequest: true, modelSemanticHint: 'brainstorm' })
    ])
    const runsRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-runs-'))
    roots.push(runsRoot)
    const coordinator = createRunCoordinator(runsRoot)
    const service = new XForgeRunService(coordinator)
    const run = service.startXForgeRun({ workspaceId: root, sessionId: 'session-nondev' })
    coordinator.markRunning(run.runId)
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-checkpoints-'))
    roots.push(checkpointRoot)

    const disposeSpy = vi.spyOn(XForgeMainAgentSession.prototype, 'dispose')
    const result = await runXForgeLiveRuntime({
      runId: run.runId,
      request: '你觉得现在的架构怎么样？',
      workspaceRoot: root,
      modelClient: client,
      parentEventBus: new EventBus(),
      parentMessageId: 'message-nondev',
      toolRegistry: new ToolRegistry(),
      skillRegistry: SkillRegistry.load({
        builtinDir: resolve('.nova/skills'),
        globalDir: join(root, '.global-skills'),
        workspaceRoot: root
      }),
      checkpointManager: new CheckpointManager({
        checkpointDir: checkpointRoot,
        sessionId: 'session-nondev',
        workspaceRoot: root
      }),
      committer: bindXForgeTestExecution(service, coordinator, run.runId),
      initializeWorkspaceBaseline: true,
      askQuestion: vi.fn(async () => []),
      readState: createReadState()
    })

    expect(result.state.currentStage).toBe('completed')
    expect(result.state.stageArtifacts).toEqual([])
    expect(result.summary).toContain('默认模式')
    expect(disposeSpy).toHaveBeenCalled()
    disposeSpy.mockRestore()
  })

  it('baseline 初始化失败时仍会 dispose session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-baseline-fail-'))
    roots.push(root)
    mkdirSync(join(root, '.nova'), { recursive: true })
    const runsRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-runs-'))
    roots.push(runsRoot)
    const coordinator = createRunCoordinator(runsRoot)
    const service = new XForgeRunService(coordinator)
    const run = service.startXForgeRun({ workspaceId: root, sessionId: 'session-baseline-fail' })
    coordinator.markRunning(run.runId)
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-checkpoints-'))
    roots.push(checkpointRoot)
    const disposeSpy = vi.spyOn(XForgeMainAgentSession.prototype, 'dispose')

    await expect(runXForgeLiveRuntime({
      runId: run.runId,
      request: '继续旧任务',
      workspaceRoot: root,
      modelClient: scriptedClient([]),
      parentEventBus: new EventBus(),
      parentMessageId: 'message-baseline-fail',
      toolRegistry: new ToolRegistry(),
      skillRegistry: SkillRegistry.load({
        builtinDir: resolve('.nova/skills'),
        globalDir: join(root, '.global-skills'),
        workspaceRoot: root
      }),
      checkpointManager: new CheckpointManager({
        checkpointDir: checkpointRoot,
        sessionId: 'session-baseline-fail',
        workspaceRoot: root
      }),
      committer: bindXForgeTestExecution(service, coordinator, run.runId),
      initializeWorkspaceBaseline: false,
      askQuestion: vi.fn(async () => []),
      readState: createReadState()
    })).rejects.toThrow('缺少 Workspace Baseline')

    expect(disposeSpy).toHaveBeenCalled()
    disposeSpy.mockRestore()
  })

  it('恢复旧 run 缺少 baseline 时 fail closed，不能把写后工作区重新冻结为起点', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-legacy-baseline-'))
    roots.push(root)
    mkdirSync(join(root, '.nova'), { recursive: true })
    writeFileSync(join(root, 'already-written.ts'), 'xforge wrote this earlier\n', 'utf8')
    const runsRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-runs-'))
    roots.push(runsRoot)
    const coordinator = createRunCoordinator(runsRoot)
    const service = new XForgeRunService(coordinator)
    const run = service.startXForgeRun({ workspaceId: root, sessionId: 'session-legacy' })
    coordinator.markRunning(run.runId)
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-checkpoints-'))
    roots.push(checkpointRoot)

    await expect(runXForgeLiveRuntime({
      runId: run.runId,
      request: '继续旧任务',
      workspaceRoot: root,
      modelClient: scriptedClient([]),
      parentEventBus: new EventBus(),
      parentMessageId: 'message-legacy',
      toolRegistry: new ToolRegistry(),
      skillRegistry: SkillRegistry.load({
        builtinDir: resolve('.nova/skills'),
        globalDir: join(root, '.global-skills'),
        workspaceRoot: root
      }),
      checkpointManager: new CheckpointManager({
        checkpointDir: checkpointRoot,
        sessionId: 'session-legacy',
        workspaceRoot: root
      }),
      committer: bindXForgeTestExecution(service, coordinator, run.runId),
      initializeWorkspaceBaseline: false,
      askQuestion: vi.fn(async () => []),
      readState: createReadState()
    })).rejects.toThrow(/缺少 Workspace Baseline/)

    expect(coordinator.getSnapshot(run.runId)?.xforge?.workspaceBaseline).toBeNull()
    expect(readFileSync(join(root, 'already-written.ts'), 'utf8')).toContain('earlier')
  })

  it('语义分类无效时保守进入 brainstorm，不进入可写实现路径', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-resolver-fallback-'))
    roots.push(root)
    mkdirSync(join(root, '.nova'), { recursive: true })
    const client = scriptedClient([
      '不是 JSON',
      JSON.stringify({
        questions: [{ question: '目标页面是什么？', options: [{ label: '登录页' }] }]
      })
    ])
    const runsRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-runs-'))
    roots.push(runsRoot)
    const coordinator = createRunCoordinator(runsRoot)
    const service = new XForgeRunService(coordinator)
    const run = service.startXForgeRun({ workspaceId: root, sessionId: 'session-fallback' })
    coordinator.markRunning(run.runId)
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-checkpoints-'))
    roots.push(checkpointRoot)

    const result = await runXForgeLiveRuntime({
      runId: run.runId,
      request: '实现一个登录页面',
      workspaceRoot: root,
      modelClient: client,
      parentEventBus: new EventBus(),
      parentMessageId: 'message-fallback',
      toolRegistry: new ToolRegistry(),
      skillRegistry: SkillRegistry.load({
        builtinDir: resolve('.nova/skills'),
        globalDir: join(root, '.global-skills'),
        workspaceRoot: root
      }),
      checkpointManager: new CheckpointManager({
        checkpointDir: checkpointRoot,
        sessionId: 'session-fallback',
        workspaceRoot: root
      }),
      committer: bindXForgeTestExecution(service, coordinator, run.runId),
      initializeWorkspaceBaseline: true,
      askQuestion: vi.fn(async () => []),
      readState: createReadState()
    })

    expect(result.state.currentStage).toBe('waiting_user')
    expect(result.state.suspendedStage).toBe('brainstorm')
    expect(result.state.tasks).toEqual([])
  })

  it('任务级验证不回退到交付级清单，交付门禁只使用计划显式命令', () => {
    const state = {
      ...createInitialXForgeRunState({ hasValidatedPlan: true }),
      validatedPlan: {
        version: 1,
        goal: '实现多任务验收',
        constraints: ['不自动 commit'],
        nonGoals: ['不做发布'],
        repositoryFacts: ['package.json 存在'],
        changeScope: ['src/example.ts'],
        tasks: [
          { id: 'T1', title: '按钮跳转', acceptance: ['按钮跳转正确'] },
          { id: 'T2', title: '定向测试', acceptance: ['`node --test targeted.mjs`'] }
        ],
        acceptanceMap: {
          T1: ['按钮跳转正确'],
          T2: ['`node --test targeted.mjs`']
        },
        verificationChecklist: ['`node --test delivery.mjs`'],
        risks: ['既有 lint 噪声不应阻断本次交付']
      }
    }

    expect(resolveXForgeTaskVerificationCommand(state, {
      id: 'T1', title: '按钮跳转', status: 'pending', acceptance: ['按钮跳转正确'], attempts: 0, evidenceRefs: []
    })).toBeNull()
    expect(resolveXForgeTaskVerificationCommand(state, {
      id: 'T2', title: '定向测试', status: 'pending', acceptance: ['`node --test targeted.mjs`'], attempts: 0, evidenceRefs: []
    })).toMatchObject({ command: 'node --test targeted.mjs', timeoutMs: 180_000 })
    expect(resolveXForgeDeliveryCommands(state)).toEqual([
      expect.objectContaining({ command: 'node --test delivery.mjs', timeoutMs: 180_000 })
    ])
  })

  it('从 plan 真实推进到 Test Gate、隔离 Review、Report 和 completed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-live-'))
    roots.push(root)
    mkdirSync(join(root, '.nova'), { recursive: true })
    writeFileSync(join(root, 'smoke.test.mjs'), [
      "import test from 'node:test'",
      "import assert from 'node:assert/strict'",
      "test('smoke', () => assert.equal(1 + 1, 2))"
    ].join('\n'))
    writeFileSync(join(root, 'implementation-plan.md'), [
      '# Implementation Plan',
      '## 变更范围',
      '- smoke.test.mjs',
      '## 任务与验收',
      '- [ ] T1 核对 smoke；验收：`node --test smoke.test.mjs`',
      '## 风险与回退',
      '- Node 环境缺失时安全暂停。'
    ].join('\n'))
    execFileSync('git', ['init'], { cwd: root })
    execFileSync('git', ['add', 'smoke.test.mjs'], { cwd: root })

    const plan = {
      plan: {
        version: 1,
        goal: '完成 smoke 验证',
        constraints: ['不提交 Git'],
        nonGoals: ['不发布'],
        repositoryFacts: ['存在 smoke.test.mjs'],
        changeScope: ['smoke.test.mjs'],
        tasks: [{ id: 'T1', title: '核对 smoke', acceptance: ['`node --test smoke.test.mjs`'] }],
        acceptanceMap: { T1: ['`node --test smoke.test.mjs`'] },
        verificationChecklist: ['`node --test smoke.test.mjs`'],
        risks: ['验证环境可能缺少 Node']
      }
    }
    const client = scriptedClient([
      JSON.stringify(plan),
      semantic(),
      JSON.stringify({ findings: [] }),
      '任务无需额外修改，现有 smoke 已满足计划。',
      'review findings 不是 JSON',
      JSON.stringify({ findings: [] })
    ])
    const runsRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-runs-'))
    roots.push(runsRoot)
    const coordinator = createRunCoordinator(runsRoot)
    const service = new XForgeRunService(coordinator)
    const run = service.startXForgeRun({ workspaceId: root, sessionId: 'session-live' })
    coordinator.markRunning(run.runId)
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-checkpoints-'))
    roots.push(checkpointRoot)
    const checkpointManager = new CheckpointManager({
      checkpointDir: checkpointRoot,
      sessionId: 'session-live',
      workspaceRoot: root
    })

    const toolRegistry = new ToolRegistry()
    const askQuestion = vi.fn(async () => [{ selectedLabels: ['保持纯静态'] }])
    const result = await runXForgeLiveRuntime({
      runId: run.runId,
      request: '按 `implementation-plan.md` 实现',
      workspaceRoot: root,
      modelClient: client,
      parentEventBus: new EventBus(),
      parentMessageId: 'message-live',
      toolRegistry,
      skillRegistry: SkillRegistry.load({
        builtinDir: resolve('.nova/skills'),
        globalDir: join(root, '.global-skills'),
        workspaceRoot: root
      }),
      checkpointManager,
      committer: bindXForgeTestExecution(service, coordinator, run.runId),
      initializeWorkspaceBaseline: true,
      askQuestion,
      readState: createReadState()
    })

    expect({ stage: result.state.currentStage, reason: result.state.waitingReason }).toEqual({
      stage: 'completed',
      reason: null
    })
    expect(result.state.tasks).toEqual([
      expect.objectContaining({ id: 'T1', status: 'done', attempts: 1 })
    ])
    expect(result.state.testEvidence?.passed).toBe(true)
    expect(result.state.reviewFindings).toEqual([])
    expect(askQuestion).toHaveBeenCalledTimes(1)
    expect(result.state.reportFacts?.shipRequested).toBe(false)
    expect(result.state.reportFacts?.notExecuted).toEqual(['commit', 'push', 'deploy', 'publish'])
    expect(result.summary).toContain('未执行：commit、push、deploy、publish')
  }, 15_000)
})
