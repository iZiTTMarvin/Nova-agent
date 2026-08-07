import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASE_TOOLS,
  READONLY_TOOLS,
  createHostFns,
  resolveAgentTools
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
  runReport,
  runVerify
} from '../../../../../src/runtime/workflow/definitions/compose'
import type {
  ComposeReportInput,
  ImplementResult,
  ReviewResult,
  VerifyResult
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

function makeImplement(overrides: Partial<ImplementResult> = {}): ImplementResult {
  return {
    status: 'completed',
    batches: 1,
    tasks: [{ taskId: 'task-a', title: '实现 A', status: 'succeeded', summary: 'A 已完成' }],
    succeededTaskIds: ['task-a'],
    failedTaskIds: [],
    ...overrides
  }
}

function makeVerify(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return {
    passed: true,
    checks: [
      { name: 'typecheck', command: 'npx tsc --noEmit', exitCode: 0, passed: true, evidence: 'ok' }
    ],
    failedChecks: [],
    ...overrides
  }
}

function makeReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    verdict: 'pass',
    summary: '实现符合计划和验证结果',
    issues: [],
    strengths: [],
    recommendations: [],
    criticalCount: 0,
    highCount: 0,
    ...overrides
  }
}

function makeReportInput(overrides: Partial<ComposeReportInput> = {}): ComposeReportInput {
  return {
    request: '实现一个完整功能',
    plan: makePlan(),
    brainstorm: null,
    implement: makeImplement(),
    verify: makeVerify(),
    review: makeReview(),
    ...overrides
  }
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

    expect(result).toMatchObject({
      status: 'completed',
      summary: '编排完成：2 个任务成功、0 个任务失败，验证检查全部通过，审查通过。'
    })
    expect(harness.progress.filter((event) => event.status === 'started').map((event) => event.phase)).toEqual([
      'brainstorm',
      'plan',
      'implement',
      'verify',
      'review',
      'report'
    ])
    expect(harness.calls.some((call) => call.options?.phase === 'report')).toBe(false)
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

  it('verify 有失败时仍把结构化失败事实交给 review 并如实进入报告，不提前终止主链路', async () => {
    const harness = makeHost()
    harness.host.bash = async (command) =>
      command === 'npx vitest run'
        ? { exitCode: 1, stdout: 'test failed', stderr: '' }
        : { exitCode: 0, stdout: 'ok', stderr: '' }

    const result = await composeWorkflow.run(runContext(harness))

    expect(harness.calls.find((call) => call.options?.phase === 'review')?.prompt).toContain(
      '"passed":false'
    )
    expect(result).toMatchObject({
      status: 'completed',
      summary: '编排完成但存在遗留问题：2 个任务成功、0 个任务失败，验证未通过（test），审查通过。',
      result: {
        outcome: 'completed_with_concerns',
        report: {
          outcome: 'completed_with_concerns',
          failures: ['test 未通过（退出码 1）：npx vitest run']
        }
      }
    })
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
      return null
    })

    const result = await composeWorkflow.run(runContext(harness))

    expect(result).toMatchObject({
      status: 'completed',
      summary: '编排完成但存在遗留问题：1 个任务成功、1 个任务失败，验证检查全部通过，审查有条件通过。',
      result: {
        outcome: 'completed_with_concerns',
        report: {
          failures: ['task-a 实现 A 失败：隔离实现 agent 未产出结果'],
          nextSteps: ['补齐 task-a']
        }
      }
    })
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

  it('brainstorm 与 plan 只拿只读工具：非 Auto 仍可提问，任何情况都不含写入工具', async () => {
    const harness = makeHost()
    await runBrainstorm(harness.host, '请求', false)
    await runPlan(harness.host, '请求', null, false)

    const research = harness.calls.filter(
      (call) => call.options?.phase === 'brainstorm' || call.options?.phase === 'plan'
    )
    expect(research.map((call) => call.options?.phase)).toEqual(['brainstorm', 'plan'])

    for (const call of research) {
      expect(call.options?.tools).toEqual([...READONLY_TOOLS])
      // isolation 表达工作区共享而非权限：改成 readonly 会连带撤掉 askQuestion
      expect(call.options?.isolation).toBe('shared')
      const resolve = (autoMode: boolean): string[] =>
        resolveAgentTools({
          isolation: call.options?.isolation ?? 'shared',
          autoMode,
          ...(call.options?.interactive === undefined ? {} : { interactive: call.options.interactive }),
          ...(call.options?.tools ? { tools: call.options.tools } : {})
        })
      expect(resolve(false)).toEqual([...READONLY_TOOLS, 'askQuestion'])
      expect(resolve(true)).toEqual([...READONLY_TOOLS])
      for (const forbidden of ['edit', 'write', 'bash']) {
        expect(resolve(false)).not.toContain(forbidden)
        expect(resolve(true)).not.toContain(forbidden)
      }
    }
  })

  it('report 由结构化事实确定性合成，不派子代理', () => {
    const harness = makeHost()
    const result = runReport(harness.host, makeReportInput())

    expect(harness.calls).toHaveLength(0)
    expect(result).toEqual({
      outcome: 'completed',
      summary: '编排完成：1 个任务成功、0 个任务失败，验证检查全部通过，审查通过。',
      highlights: ['task-a 实现 A：A 已完成'],
      failures: [],
      nextSteps: []
    })
    expect(harness.progress).toEqual([
      { phase: 'report', status: 'started' },
      { phase: 'report', status: 'completed', message: result.summary }
    ])
  })

  it('report 在失败任务、验证失败、有条件通过或高危问题下判定为 completed_with_concerns', () => {
    const harness = makeHost()

    const partial = runReport(
      harness.host,
      makeReportInput({
        implement: makeImplement({
          status: 'partial',
          tasks: [
            { taskId: 'task-a', title: '实现 A', status: 'succeeded', summary: 'A 已完成' },
            { taskId: 'task-b', title: '实现 B', status: 'failed', failure: '实现 agent 未产出结果' }
          ],
          succeededTaskIds: ['task-a'],
          failedTaskIds: ['task-b']
        })
      })
    )
    expect(partial.outcome).toBe('completed_with_concerns')
    expect(partial.summary).toBe(
      '编排完成但存在遗留问题：1 个任务成功、1 个任务失败，验证检查全部通过，审查通过。'
    )
    expect(partial.highlights).toEqual(['task-a 实现 A：A 已完成'])
    expect(partial.failures).toEqual(['task-b 实现 B 失败：实现 agent 未产出结果'])

    const verifyFailed = runReport(
      harness.host,
      makeReportInput({
        verify: makeVerify({
          passed: false,
          checks: [
            { name: 'typecheck', command: 'npx tsc --noEmit', exitCode: 0, passed: true, evidence: 'ok' },
            { name: 'test', command: 'npx vitest run', exitCode: 1, passed: false, evidence: 'test failed' }
          ],
          failedChecks: ['test']
        })
      })
    )
    expect(verifyFailed.outcome).toBe('completed_with_concerns')
    expect(verifyFailed.summary).toContain('验证未通过（test）')
    expect(verifyFailed.failures).toEqual(['test 未通过（退出码 1）：npx vitest run'])

    const conditional = runReport(
      harness.host,
      makeReportInput({
        review: makeReview({
          verdict: 'conditional',
          issues: [{ severity: 'medium', summary: '命名可以更直接' }],
          recommendations: ['补齐边界测试']
        })
      })
    )
    expect(conditional.outcome).toBe('completed_with_concerns')
    expect(conditional.summary).toContain('审查有条件通过')
    // 中低级别问题不进 failures，只有高危问题才算失败事实
    expect(conditional.failures).toEqual([])
    expect(conditional.nextSteps).toEqual(['补齐边界测试'])

    const highIssue = runReport(
      harness.host,
      makeReportInput({
        review: makeReview({
          issues: [{ severity: 'high', file: 'src/a.ts', line: 12, summary: '缺少取消清理' }],
          highCount: 1
        })
      })
    )
    expect(highIssue.outcome).toBe('completed_with_concerns')
    expect(highIssue.failures).toEqual(['审查 high 问题：src/a.ts:12 缺少取消清理'])

    expect(harness.calls).toHaveLength(0)
  })

  it('report 在实现整体失败或审查判定阻塞时判定为 blocked', () => {
    const harness = makeHost()

    const implementFailed = runReport(
      harness.host,
      makeReportInput({
        implement: makeImplement({
          status: 'failed',
          tasks: [],
          succeededTaskIds: [],
          failedTaskIds: [],
          fatalReason: 'WorkflowPlan 存在循环依赖，无法形成可执行批次'
        })
      })
    )
    expect(implementFailed.outcome).toBe('blocked')
    expect(implementFailed.summary).toBe(
      '编排受阻：0 个任务成功、0 个任务失败，验证检查全部通过，审查通过。'
    )
    expect(implementFailed.failures).toEqual([
      '实现阶段中止：WorkflowPlan 存在循环依赖，无法形成可执行批次'
    ])

    const reviewBlocked = runReport(
      harness.host,
      makeReportInput({
        review: makeReview({
          verdict: 'block',
          summary: '越过依赖边界',
          issues: [{ severity: 'critical', summary: 'renderer 直接依赖 Electron' }],
          criticalCount: 1,
          recommendations: ['改回经 preload 桥接']
        })
      })
    )
    expect(reviewBlocked.outcome).toBe('blocked')
    expect(reviewBlocked.summary).toContain('审查判定阻塞')
    expect(reviewBlocked.failures).toEqual(['审查 critical 问题：renderer 直接依赖 Electron'])
    expect(reviewBlocked.nextSteps).toEqual(['改回经 preload 桥接'])

    expect(harness.calls).toHaveLength(0)
  })

  it('实现、验证、审查完成后不再因为汇报环节判定整条工作流失败', async () => {
    const harness = makeHost()
    const behavior = harness.behavior
    harness.host.agent = async (prompt, options) => {
      if (options?.phase === 'report') throw new Error('report 阶段不应派遣子代理')
      harness.calls.push({ prompt, ...(options ? { options } : {}) })
      return behavior(prompt, options)
    }

    const result = await composeWorkflow.run(runContext(harness))

    expect(result.status).toBe('completed')
    expect(harness.progress).toEqual(
      expect.arrayContaining([expect.objectContaining({ phase: 'report', status: 'completed' })])
    )
    expect(harness.progress.some((event) => event.phase === 'report' && event.status === 'failed')).toBe(
      false
    )
  })
})
