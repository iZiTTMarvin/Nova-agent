import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
import { askQuestionTool } from '../../../../../src/runtime/tools/askQuestionTool'
import { createReadState } from '../../../../../src/runtime/tools/editTool'
import { writeTool } from '../../../../../src/runtime/tools/writeTool'
import {
  classifyXForgeRequest,
  normalizeXForgeBrainstormPayload,
  resolveXForgeDeliveryCommands,
  resolveXForgeTaskVerificationCommand,
  runXForgeLiveRuntime
} from '../../../../../src/runtime/workflow/xforge/liveRuntime'
import { createInitialXForgeRunState } from '../../../../../src/runtime/workflow/xforge/runState'

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

describe('XForge live Runtime', () => {
  it('自然语言与显式约束解析到安全起点', () => {
    expect(classifyXForgeRequest('实现一个登录页面').modelSemanticHint).toBe('plan')
    expect(classifyXForgeRequest('我想加浏览器能力，还没想清楚').modelSemanticHint).toBe('brainstorm')
    expect(classifyXForgeRequest('我打算优化我的项目，你觉得呢').modelSemanticHint).toBe('brainstorm')
    expect(classifyXForgeRequest('代码已经改好，只帮我测试').codeReadyForTest).toBe(true)
    expect(classifyXForgeRequest('只审查，不要改代码').reviewOnly).toBe(true)
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
      artifactMarkdown: '# 中文阅读排版方案'
    })
    expect(normalizeXForgeBrainstormPayload({
      needsMoreClarification: true,
      mainSession: fallback
    }, fallback)).toEqual({
      needsMoreClarification: true,
      mainSession: fallback,
      artifactMarkdown: ''
    })
  })

  it('brainstorm 不按阶段拒绝基础工具，方法 body 契约可由 Runtime 正常接管', async () => {
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
      },
      artifactMarkdown: '# 实施计划'
    }
    const client = scriptedClient([
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
      JSON.stringify({ findings: [], artifactMarkdown: '# Scope\n\nPASS' }),
      '已按任务完成实现。'
    ])
    const runsRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-runs-'))
    roots.push(runsRoot)
    const coordinator = createRunCoordinator(runsRoot)
    const run = coordinator.startXForgeRun({ workspaceId: root, sessionId: 'session-brainstorm' })
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

    const result = await runXForgeLiveRuntime({
      runId: run.runId,
      request: '我想优化博客阅读体验',
      workspaceRoot: root,
      modelClient: client,
      parentEventBus: new EventBus(),
      parentMessageId: 'message-brainstorm',
      toolRegistry,
      skillRegistry: SkillRegistry.load({
        builtinDir: resolve('.nova/skills'),
        globalDir: join(root, '.global-skills'),
        workspaceRoot: root
      }),
      checkpointManager,
      committer: coordinator,
      askQuestion: vi.fn(async () => [{ selectedLabels: ['中文长文'] }]),
      readState: createReadState()
    })

    expect(readFileSync(join(root, '.buildrail/idea/typography.md'), 'utf8')).toBe('# 中文阅读排版方案')
    expect(result.state.stageArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'brainstorm' })
    ]))
    expect(result.state.mainSession.userDecisions).toEqual(['中文长文'])
    expect(result.state.currentStage).toBe('waiting_user')
    expect(result.state.waitingReason).toContain('Test Gate 缺少')
  })

  it('结构化结果最终无效时保留真实失败原因，不改写成 Pipeline 泛化错误', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-invalid-brainstorm-'))
    roots.push(root)
    mkdirSync(join(root, '.nova'), { recursive: true })
    const client = scriptedClient([
      JSON.stringify({
        questions: [{ question: '优化重点是什么？', options: [{ label: '阅读体验' }] }]
      }),
      '这不是 JSON',
      '仍然不是 JSON'
    ])
    const runsRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-runs-'))
    roots.push(runsRoot)
    const coordinator = createRunCoordinator(runsRoot)
    const run = coordinator.startXForgeRun({ workspaceId: root, sessionId: 'session-invalid' })
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
      committer: coordinator,
      askQuestion: vi.fn(async () => [{ selectedLabels: ['阅读体验'] }]),
      readState: createReadState()
    })).rejects.toThrow('结构化结果无效')

    const snapshot = coordinator.getSnapshot(run.runId)
    expect(snapshot?.xforge?.currentStage).toBe('failed')
    expect(snapshot?.xforge?.lastTransitionReason).toContain('结构化结果无效')
    expect(snapshot?.xforge?.lastTransitionReason).not.toContain('Pipeline 未进入')
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
      },
      artifactMarkdown: '# Plan\n\nRun the smoke test.'
    }
    const client = scriptedClient([
      [
        { type: 'message_start' },
        { type: 'tool_call_start', toolCallId: 'ask-plan', toolName: 'askQuestion', index: 0 },
        {
          type: 'tool_call',
          toolCall: {
            id: 'ask-plan',
            name: 'askQuestion',
            arguments: JSON.stringify({
              questions: [{
                question: '是否保持纯静态？',
                options: [{ label: '保持纯静态' }]
              }]
            })
          }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ],
      JSON.stringify(plan),
      JSON.stringify({ findings: [], artifactMarkdown: '# Scope\n\nPASS' }),
      '任务无需额外修改，现有 smoke 已满足计划。',
      JSON.stringify({ findings: [] })
    ])
    const runsRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-runs-'))
    roots.push(runsRoot)
    const coordinator = createRunCoordinator(runsRoot)
    const run = coordinator.startXForgeRun({ workspaceId: root, sessionId: 'session-live' })
    coordinator.markRunning(run.runId)
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-checkpoints-'))
    roots.push(checkpointRoot)
    const checkpointManager = new CheckpointManager({
      checkpointDir: checkpointRoot,
      sessionId: 'session-live',
      workspaceRoot: root
    })

    const toolRegistry = new ToolRegistry()
    toolRegistry.register(askQuestionTool)
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
      committer: coordinator,
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
    expect(askQuestion).toHaveBeenCalledTimes(2)
    expect(result.state.reportFacts?.shipRequested).toBe(false)
    expect(result.state.reportFacts?.notExecuted).toEqual(['commit', 'push', 'deploy', 'publish'])
    expect(result.summary).toContain('未执行 commit、push、deploy 或 publish')
  })
})
