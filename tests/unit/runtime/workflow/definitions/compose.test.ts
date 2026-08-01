import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASE_TOOLS,
  READONLY_TOOLS,
  createHostFns
} from '../../../../../src/runtime/workflow/host'
import type {
  AgentResult,
  AgentOptions,
  HostFns,
  WorktreeHandle
} from '../../../../../src/runtime/workflow/host'
import type { WorkflowRunContext } from '../../../../../src/runtime/workflow/definitions/types'
import {
  composeWorkflow,
  runBrainstorm,
  runImplement,
  runPlan,
  runVerify
} from '../../../../../src/runtime/workflow/definitions/compose'
import type { WorkflowPlan } from '../../../../../src/runtime/workflow/types'
import { addTextResponse, makeHostHarness } from '../host/hostTestContext'
import type { ToolExecutor, ToolResult } from '../../../../../src/runtime/tools/types'

function fakeTool(name: string): ToolExecutor {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      return { success: true, output: 'ok' }
    }
  }
}

const JOURNAL_TOOLS = [...new Set([...BASE_TOOLS, ...READONLY_TOOLS, 'askQuestion'])].map(fakeTool)

interface AgentCall {
  prompt: string
  options?: AgentOptions
}

interface ComposeHostHarness {
  host: HostFns
  calls: AgentCall[]
  progress: Array<{ phase: string; status: string; message?: string }>
  integrations: string[]
  cleaned: string[]
  behavior: (prompt: string, options: AgentOptions | undefined) => Promise<AgentResult>
}

function makePlan(tasks: WorkflowPlan['tasks'] = [
  { id: 'task-a', title: '实现 A', dependsOn: [], acceptance: ['A 完成'] },
  { id: 'task-b', title: '实现 B', dependsOn: [], acceptance: ['B 完成'] }
]): WorkflowPlan {
  return {
    version: 1,
    goal: '完成用户请求',
    constraints: ['保持现有公共契约'],
    nonGoals: ['不处理无关模块'],
    repositoryFacts: ['项目存在 typecheck、test、build 门禁'],
    changeScope: ['当前工作区'],
    tasks,
    acceptanceMap: Object.fromEntries(tasks.map((task) => [task.id, task.acceptance])),
    verificationChecklist: ['typecheck', 'test', 'build'],
    risks: ['并行改动可能产生合并冲突']
  }
}

function makeHost(
  behavior?: (prompt: string, options: AgentOptions | undefined) => Promise<AgentResult>
): ComposeHostHarness {
  const calls: AgentCall[] = []
  const progress: ComposeHostHarness['progress'] = []
  const integrations: string[] = []
  const cleaned: string[] = []
  const defaultBehavior = async (prompt: string, options: AgentOptions | undefined): Promise<AgentResult> => {
    if (options?.phase === 'brainstorm') {
      return {
        summary: '比较实现方向',
        alternatives: [
          { id: 'a', title: '方案 A', approach: '直接沿现有边界实现', tradeoffs: [], risks: [] },
          { id: 'b', title: '方案 B', approach: '扩大范围重构', tradeoffs: ['范围更大'], risks: ['回归面更大'] }
        ],
        recommendation: '方案 A',
        openQuestions: []
      }
    }
    if (options?.phase === 'plan') return makePlan()
    if (options?.phase === 'implement') return `完成 ${prompt.match(/任务 (task-[ab])/u)?.[1] ?? '任务'}`
    if (options?.phase === 'review') {
      return {
        verdict: 'pass',
        summary: '实现符合计划和验证结果',
        issues: [],
        strengths: ['沿用既有边界'],
        recommendations: []
      }
    }
    if (options?.phase === 'report') {
      return {
        outcome: 'completed',
        summary: 'compose workflow 已完成',
        highlights: ['实现、验证和审查均已执行'],
        failures: [],
        nextSteps: []
      }
    }
    return null
  }
  const agentBehavior = behavior ?? defaultBehavior

  const host: HostFns = {
    agent: async (prompt, options) => {
      calls.push({ prompt, ...(options ? { options } : {}) })
      return agentBehavior(prompt, options)
    },
    bash: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    read: async () => null,
    write: async () => undefined,
    delete: async () => undefined,
    exists: async () => false,
    glob: async () => [],
    worktree: async (key): Promise<WorktreeHandle> => ({
      key,
      name: key,
      branch: `${key}-branch`,
      directory: `/tmp/${key}`,
      baseSha: 'base-sha',
      reused: false
    }),
    integrate: async (directory) => {
      integrations.push(directory)
      return { status: 'merged', strategy: 'fast-forward', sha: 'merged-sha' }
    },
    cleanupWorktree: async (directory) => {
      cleaned.push(directory)
      return true
    },
    progress: (phase, status, detail) => {
      progress.push({ phase, status, ...(detail?.message ? { message: detail.message } : {}) })
    },
    log: () => undefined,
    supportsWorktree: () => true
  }
  return { host, calls, progress, integrations, cleaned, behavior: agentBehavior }
}

function runContext(harness: ComposeHostHarness, autoMode = false): WorkflowRunContext {
  return {
    host: harness.host,
    request: '实现一个完整功能',
    startStage: 'brainstorm',
    injectedContext: {},
    abortSignal: new AbortController().signal,
    autoMode
  }
}

describe('compose workflow definitions', () => {
  it('完整串联六阶段，按拓扑批次并行隔离并合并', async () => {
    const harness = makeHost()
    const result = await composeWorkflow.run(runContext(harness))

    expect(result).toMatchObject({ status: 'completed', summary: 'compose workflow 已完成' })
    expect(harness.progress.filter((event) => event.status === 'started').map((event) => event.phase)).toEqual([
      'brainstorm',
      'plan',
      'implement',
      'verify',
      'review',
      'report'
    ])
    expect(harness.calls.filter((call) => call.options?.phase === 'implement')).toHaveLength(2)
    expect(harness.calls.filter((call) => call.options?.phase === 'implement').every((call) => call.options?.interactive === false)).toBe(true)
    expect(harness.calls.filter((call) => call.options?.phase === 'implement').every((call) => !(call.options?.tools ?? []).includes('askQuestion'))).toBe(true)
    expect(harness.integrations).toEqual(['/tmp/compose-implement-task-a', '/tmp/compose-implement-task-b'])
    expect(harness.progress.some((event) => event.status === 'batch_merge')).toBe(true)
  })

  it('非 git 工作区下多任务批次降级到主工作区顺序执行，不创建 worktree', async () => {
    const harness = makeHost()
    // 模拟非 git 项目：host 声明不支持 worktree，且 worktree 被调用时应抛错
    harness.host.supportsWorktree = () => false
    harness.host.worktree = async () => {
      throw new Error('should not call worktree in non-git workspace')
    }

    const result = await runImplement(harness.host, makePlan(), null)

    expect(result.status).toBe('completed')
    const implementCalls = harness.calls.filter((call) => call.options?.phase === 'implement')
    expect(implementCalls).toHaveLength(2)
    expect(implementCalls.every((call) => call.options?.isolation === 'shared')).toBe(true)
    expect(harness.integrations).toHaveLength(0)
    expect(harness.progress.some((event) => event.status === 'batch_merge')).toBe(true)
  })

  it('startStage=plan 跳过 brainstorm，不静默拖回方案构思', async () => {
    const harness = makeHost()
    const result = await composeWorkflow.run({
      ...runContext(harness),
      startStage: 'plan'
    })

    expect(result.status).toBe('completed')
    expect(harness.calls.some((call) => call.options?.phase === 'brainstorm')).toBe(false)
    expect(harness.calls.some((call) => call.options?.phase === 'plan')).toBe(true)
    expect(harness.progress.filter((event) => event.status === 'started').map((event) => event.phase)).toEqual([
      'plan',
      'implement',
      'verify',
      'review',
      'report'
    ])
  })

  it('Auto 关闭时 brainstorm/plan 请求交互，Auto 开启时剔除交互权限', async () => {
    const interactive = makeHost()
    await runBrainstorm(interactive.host, '请求', false)
    await runPlan(interactive.host, '请求', null, false)
    expect(interactive.calls.slice(0, 2).map((call) => call.options?.interactive)).toEqual([true, true])

    const automatic = makeHost()
    await runBrainstorm(automatic.host, '请求', true)
    await runPlan(automatic.host, '请求', null, true)
    expect(automatic.calls.slice(0, 2).map((call) => call.options?.interactive)).toEqual([false, false])
  })

  it('active plan 只作为 plan agent 的转换输入，并保留 dependsOn 结构', async () => {
    const harness = makeHost()
    const activePlan = '# 当前计划\n\n- 先完成入口\n- 再完成验证'
    const result = await runPlan(harness.host, '继续实施当前计划', null, false, {
      path: '.nova/plans/current.md',
      content: activePlan
    })

    expect(result?.tasks.every((task) => Array.isArray(task.dependsOn))).toBe(true)
    expect(harness.calls[0]?.prompt).toContain(activePlan)
    expect(harness.calls[0]?.prompt).toContain('只负责把 Markdown 转成带 dependsOn 的结构化 WorkflowPlan')
  })

  it('compose 阶段复用 host journal：首次执行 spawn，resume 命中缓存不再 spawn', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'nova-compose-journal-'))
    try {
      const harness = makeHostHarness(workspace, { tools: JOURNAL_TOOLS })
      addTextResponse(
        harness.client,
        JSON.stringify({
          summary: '缓存的头脑风暴',
          alternatives: [{ title: '方案', approach: '沿用现有边界' }],
          recommendation: '方案',
          assumptions: [],
          openQuestions: []
        })
      )
      const first = await runBrainstorm(createHostFns(harness.ctx), '恢复请求', false)

      harness.ctx.occ.clear()
      const second = await runBrainstorm(createHostFns(harness.ctx), '恢复请求', false)

      expect(second).toEqual(first)
      expect(harness.client.getCalls()).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('verify 聚合 typecheck、test、build 失败，不因前一项失败而短路', async () => {
    const harness = makeHost()
    const commands: string[] = []
    harness.host.bash = async (command) => {
      commands.push(command)
      if (command === 'npx vitest run') {
        return { exitCode: 1, stdout: 'test failed', stderr: '' }
      }
      if (command === 'npm run build') {
        return { exitCode: 2, stdout: '', stderr: 'build failed' }
      }
      return { exitCode: 0, stdout: 'typecheck passed', stderr: '' }
    }

    const result = await runVerify(harness.host)

    expect(result).toMatchObject({
      passed: false,
      failedChecks: ['test', 'build']
    })
    expect(commands).toEqual(['npx tsc --noEmit', 'npx vitest run', 'npm run build'])
    expect(harness.progress).toEqual(
      expect.arrayContaining([expect.objectContaining({ phase: 'verify', status: 'failed' })])
    )
  })

  it('verify 有失败时仍把结构化失败事实交给 review/report，不提前终止主链路', async () => {
    const harness = makeHost()
    harness.host.bash = async (command) =>
      command === 'npx vitest run'
        ? { exitCode: 1, stdout: 'test failed', stderr: '' }
        : { exitCode: 0, stdout: 'ok', stderr: '' }

    const result = await composeWorkflow.run(runContext(harness))

    expect(result.status).toBe('completed')
    expect(harness.calls.map((call) => call.options?.phase)).toEqual(
      expect.arrayContaining(['review', 'report'])
    )
    expect(harness.calls.find((call) => call.options?.phase === 'review')?.prompt).toContain(
      '"passed":false'
    )
  })

  it('同批一个实现失败时不取消独立任务，失败 worktree 清理而成功任务继续 integrate', async () => {
    const harness = makeHost(async (prompt, options) => {
      if (options?.phase === 'brainstorm') {
        return {
          summary: '方案',
          alternatives: [{ title: '方案', approach: '实现', tradeoffs: [], risks: [] }],
          recommendation: '方案',
          openQuestions: []
        }
      }
      if (options?.phase === 'plan') return makePlan()
      if (options?.phase === 'implement' && prompt.includes('task-a')) return null
      if (options?.phase === 'implement') return 'task-b 完成'
      if (options?.phase === 'review') {
        return { verdict: 'conditional', summary: '存在实现失败', issues: [], strengths: [], recommendations: ['补齐 task-a'] }
      }
      if (options?.phase === 'report') {
        return {
          outcome: 'completed_with_concerns',
          summary: '部分任务失败，已生成报告',
          highlights: ['task-b 已合并'],
          failures: ['task-a 实现失败'],
          nextSteps: ['补齐 task-a']
        }
      }
      return null
    })

    const result = await composeWorkflow.run(runContext(harness))

    expect(result).toMatchObject({ status: 'completed', summary: '部分任务失败，已生成报告' })
    expect(harness.integrations).toEqual(['/tmp/compose-implement-task-b'])
    expect(harness.cleaned).toEqual(['/tmp/compose-implement-task-a'])
    expect(harness.progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'task_failed', phase: 'implement' }),
        expect.objectContaining({ status: 'task_complete', phase: 'implement' })
      ])
    )
  })

  it('取消信号在进入阶段前返回失败结果，不伪造 completed', async () => {
    const harness = makeHost()
    const controller = new AbortController()
    controller.abort()
    const result = await composeWorkflow.run({
      ...runContext(harness),
      abortSignal: controller.signal
    })

    expect(result).toEqual({ status: 'failed', reason: 'workflow cancelled' })
    expect(harness.calls).toHaveLength(0)
  })
})
