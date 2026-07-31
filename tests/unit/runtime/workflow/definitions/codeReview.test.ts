/**
 * code-review workflow 的定向测试。
 *
 * 保护的不变量：
 * - 范围收集优先未提交改动，工作区干净时回退到最近一次提交；
 * - 非 git 仓库或没有可审查对象时立刻失败，不空跑 agent；
 * - 未跟踪文件不会被漏掉；
 * - 审查阶段只读、不提问、不创建 worktree；
 * - verdict 与问题清单不允许自相矛盾。
 */
import { describe, expect, it } from 'vitest'
import type { AgentOptions, AgentResult, BashResult, HostFns, WorktreeHandle } from '../../../../../src/runtime/workflow/host'
import type { WorkflowRunContext } from '../../../../../src/runtime/workflow/definitions/types'
import {
  codeReviewWorkflow,
  collectCodeReviewScope,
  normalizeCodeReview
} from '../../../../../src/runtime/workflow/definitions/code-review'

interface Harness {
  host: HostFns
  agentCalls: Array<{ prompt: string; options?: AgentOptions }>
  bashCalls: string[]
  worktreeCalls: string[]
  progress: Array<{ phase: string; status: string; message?: string }>
}

const REVIEW_OUTPUT = {
  verdict: 'conditional',
  summary: '主路径正确，但缺少失败路径测试',
  findings: [
    {
      severity: 'high',
      file: 'src/a.ts',
      line: 12,
      summary: '未处理 null 返回',
      suggestion: '补充空值分支'
    }
  ],
  strengths: ['沿用既有边界'],
  unverified: ['无法在只读环境执行测试']
}

/** 工作区有未提交改动的 git 响应 */
const DIRTY_WORKING_TREE: Record<string, BashResult> = {
  'git rev-parse --is-inside-work-tree': { exitCode: 0, stdout: 'true\n', stderr: '' },
  'git status --porcelain': { exitCode: 0, stdout: ' M src/a.ts\n?? src/new.ts\n', stderr: '' },
  'git diff --name-only HEAD': { exitCode: 0, stdout: 'src/a.ts\n', stderr: '' },
  'git diff --stat HEAD': { exitCode: 0, stdout: ' src/a.ts | 4 +++-\n', stderr: '' },
  'git diff --unified=3 HEAD': { exitCode: 0, stdout: '--- a/src/a.ts\n+++ b/src/a.ts\n', stderr: '' }
}

/** 工作区干净、只能审查最近一次提交的 git 响应 */
const CLEAN_WORKING_TREE: Record<string, BashResult> = {
  'git rev-parse --is-inside-work-tree': { exitCode: 0, stdout: 'true\n', stderr: '' },
  'git status --porcelain': { exitCode: 0, stdout: '', stderr: '' },
  'git diff --name-only HEAD': { exitCode: 0, stdout: '', stderr: '' },
  'git diff --stat HEAD': { exitCode: 0, stdout: '', stderr: '' },
  'git diff --unified=3 HEAD': { exitCode: 0, stdout: '', stderr: '' },
  'git diff --name-only HEAD~1 HEAD': { exitCode: 0, stdout: 'src/b.ts\n', stderr: '' },
  'git diff --stat HEAD~1 HEAD': { exitCode: 0, stdout: ' src/b.ts | 2 +-\n', stderr: '' },
  'git diff --unified=3 HEAD~1 HEAD': { exitCode: 0, stdout: '--- a/src/b.ts\n', stderr: '' }
}

function makeHarness(
  bashResponses: Record<string, BashResult>,
  agentBehavior?: (prompt: string, options: AgentOptions | undefined) => Promise<AgentResult>
): Harness {
  const agentCalls: Harness['agentCalls'] = []
  const bashCalls: string[] = []
  const worktreeCalls: string[] = []
  const progress: Harness['progress'] = []

  const host: HostFns = {
    agent: async (prompt, options) => {
      agentCalls.push({ prompt, ...(options ? { options } : {}) })
      return agentBehavior ? agentBehavior(prompt, options) : REVIEW_OUTPUT
    },
    bash: async (command) => {
      bashCalls.push(command)
      // 未登记的命令视为失败，避免测试悄悄依赖真实 git
      return bashResponses[command] ?? { exitCode: 1, stdout: '', stderr: `unexpected: ${command}` }
    },
    read: async () => null,
    write: async () => undefined,
    delete: async () => undefined,
    exists: async () => false,
    glob: async () => [],
    worktree: async (key): Promise<WorktreeHandle> => {
      worktreeCalls.push(key)
      return {
        key,
        name: key,
        branch: `${key}-branch`,
        directory: `/tmp/${key}`,
        baseSha: 'base',
        reused: false
      }
    },
    integrate: async () => ({ status: 'pristine' }),
    cleanupWorktree: async () => true,
    progress: (phase, status, detail) => {
      progress.push({ phase, status, ...(detail?.message ? { message: detail.message } : {}) })
    },
    log: () => undefined
  }
  return { host, agentCalls, bashCalls, worktreeCalls, progress }
}

function runContext(harness: Harness, aborted = false): WorkflowRunContext {
  const controller = new AbortController()
  if (aborted) controller.abort()
  return {
    host: harness.host,
    request: '审查一下我刚改的代码',
    startStage: 'review',
    injectedContext: {},
    abortSignal: controller.signal,
    autoMode: false
  }
}

describe('code-review workflow', () => {
  it('只暴露 review 作为起始阶段，并携带路由匹配信号', () => {
    expect(codeReviewWorkflow.name).toBe('code-review')
    expect(codeReviewWorkflow.stages).toEqual(['review'])
    expect(codeReviewWorkflow.matchHints.length).toBeGreaterThan(0)
  })

  it('优先审查工作区未提交改动，并带上未跟踪文件', async () => {
    const harness = makeHarness(DIRTY_WORKING_TREE)
    const scope = await collectCodeReviewScope(harness.host)

    expect(scope).toMatchObject({
      origin: 'working-tree',
      baseRef: 'HEAD',
      changedFiles: ['src/a.ts'],
      untrackedFiles: ['src/new.ts'],
      truncated: false
    })
    // 工作区已有改动，不应再去比较上一次提交
    expect(harness.bashCalls.some((command) => command.includes('HEAD~1'))).toBe(false)
  })

  it('工作区干净时回退到最近一次提交', async () => {
    const harness = makeHarness(CLEAN_WORKING_TREE)
    const scope = await collectCodeReviewScope(harness.host)

    expect(scope).toMatchObject({
      origin: 'last-commit',
      baseRef: 'HEAD~1',
      changedFiles: ['src/b.ts'],
      untrackedFiles: []
    })
  })

  it('非 git 仓库直接失败，不发起审查', async () => {
    const harness = makeHarness({
      'git rev-parse --is-inside-work-tree': { exitCode: 128, stdout: '', stderr: 'not a git repo' }
    })
    const result = await codeReviewWorkflow.run(runContext(harness))

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('unreachable')
    expect(result.reason).toContain('无法确定审查范围')
    expect(harness.agentCalls).toHaveLength(0)
  })

  it('没有任何可审查改动时失败，不空跑 agent', async () => {
    const harness = makeHarness({
      ...CLEAN_WORKING_TREE,
      'git diff --name-only HEAD~1 HEAD': { exitCode: 0, stdout: '', stderr: '' }
    })
    const result = await codeReviewWorkflow.run(runContext(harness))

    expect(result.status).toBe('failed')
    expect(harness.agentCalls).toHaveLength(0)
  })

  it('审查阶段只读、不提问、不创建 worktree，并产出带行号的摘要', async () => {
    const harness = makeHarness(DIRTY_WORKING_TREE)
    const result = await codeReviewWorkflow.run(runContext(harness))

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error('unreachable')
    expect(harness.agentCalls).toHaveLength(1)
    expect(harness.agentCalls[0]?.options).toMatchObject({
      phase: 'review',
      isolation: 'readonly',
      interactive: false
    })
    expect(harness.worktreeCalls).toHaveLength(0)
    expect(harness.agentCalls[0]?.prompt).toContain('src/new.ts')
    expect(result.summary).toContain('审查结论：conditional')
    expect(result.summary).toContain('src/a.ts:12')
    expect(result.summary).toContain('无法在只读环境执行测试')
  })

  it('已取消时不收集范围也不发起审查', async () => {
    const harness = makeHarness(DIRTY_WORKING_TREE)
    const result = await codeReviewWorkflow.run(runContext(harness, true))

    expect(result).toEqual({ status: 'failed', reason: 'workflow cancelled' })
    expect(harness.bashCalls).toHaveLength(0)
    expect(harness.agentCalls).toHaveLength(0)
  })

  it('存在 critical 问题时强制 block，不采信模型给的 pass', () => {
    const review = normalizeCodeReview({
      verdict: 'pass',
      summary: '没什么问题',
      findings: [{ severity: 'critical', summary: '权限校验被绕过' }]
    })
    expect(review?.verdict).toBe('block')
    expect(review?.criticalCount).toBe(1)
  })

  it('存在 high 问题时 pass 降级为 conditional', () => {
    const review = normalizeCodeReview({
      verdict: 'pass',
      summary: '整体可以',
      findings: [{ severity: 'high', summary: '未处理失败路径' }]
    })
    expect(review?.verdict).toBe('conditional')
  })

  it('未产出结构化结论时阶段失败', async () => {
    const harness = makeHarness(DIRTY_WORKING_TREE, async () => null)
    const result = await codeReviewWorkflow.run(runContext(harness))

    expect(result).toEqual({ status: 'failed', reason: 'review failed' })
    expect(harness.progress.some((event) => event.status === 'failed')).toBe(true)
  })
})
