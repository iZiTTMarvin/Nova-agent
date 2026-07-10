/**
 * 阶段 D：br-full-dev 五阶段脚本 + askUser / skipped / resume 行为验收
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import {
  runWorkflow,
  resolveWorkflowAskUser,
  getWorkflowStatus,
  _resetWorkflowRuntimeForTests
} from '../../../../src/runtime/workflow/runtime'
import { statePath, runJournalPath } from '../../../../src/runtime/workflow/paths'
import { getBuiltinScript } from '../../../../src/runtime/workflow/builtin'
import type { ComposeState, WorkflowRuntimeDeps } from '../../../../src/runtime/workflow/types'
import type { ToolResult } from '../../../../src/runtime/tools/types'

function makeDeps(
  workspaceRoot: string,
  client: MockModelClient,
  extra?: Partial<WorkflowRuntimeDeps>
): WorkflowRuntimeDeps {
  const reg = new ToolRegistry()
  for (const name of ['ls', 'read', 'grep', 'find', 'edit', 'write', 'bash', 'todo_write']) {
    reg.register({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolResult> {
        return { success: true, output: 'ok' }
      }
    })
  }
  return {
    modelClient: client,
    parentEventBus: new EventBus(),
    resolveTool: (n) => reg.getTool(n),
    workspaceRoot,
    mode: 'compose',
    ...extra
  }
}

/** 排队一段 JSON 文本作为 agent 返回 */
function queueJson(client: MockModelClient, obj: unknown): void {
  client.addResponse({
    events: [
      { type: 'message_start' },
      { type: 'text_delta', delta: JSON.stringify(obj) },
      { type: 'message_end', finishReason: 'stop' }
    ]
  })
}

function queueText(client: MockModelClient, text: string): void {
  client.addResponse({
    events: [
      { type: 'message_start' },
      { type: 'text_delta', delta: text },
      { type: 'message_end', finishReason: 'stop' }
    ]
  })
}

/** happy path：探索→计划→单任务执行→审查→askUser(暂不提交) */
function queueHappyPath(client: MockModelClient): void {
  queueJson(client, { route: 'br-brainstorming', reason: '小功能' })
  queueJson(client, {
    title: 'todo-cli',
    body: '# Todo CLI\n\n目标：实现一个 Todo CLI。\n',
    route: 'br-brainstorming'
  })
  queueJson(client, { highCount: 0, highs: [], summary: 'ok' })
  queueJson(client, {
    title: 'todo-cli',
    body: '# Plan\n\n- task-001\n',
    tasks: [
      {
        id: 'task-001',
        title: '实现 TodoStore',
        size: 'S',
        deps: [],
        verify: '单元测试通过'
      }
    ]
  })
  queueJson(client, { summary: '实现完成', files: ['src/todo.ts'] })
  queueJson(client, {
    allPassed: true,
    pass: 1,
    fail: 0,
    evidence: '1 passed',
    failures: [],
    timeout: false
  })
  queueJson(client, {
    verdict: 'pass',
    criticalCount: 0,
    highCount: 0,
    criticals: [],
    issues: []
  })
}

/** 单任务 verify 始终失败 + debug unresolved ×3 → skipped */
function queueVerifyFail3x(client: MockModelClient): void {
  queueJson(client, { route: 'br-brainstorming', reason: '小功能' })
  queueJson(client, {
    title: 'fail-task',
    body: '# Design\n',
    route: 'br-brainstorming'
  })
  queueJson(client, { highCount: 0, highs: [], summary: 'ok' })
  queueJson(client, {
    title: 'fail-task',
    body: '# Plan\n',
    tasks: [
      { id: 'task-001', title: '必失败任务', size: 'S', deps: [], verify: '永远失败' }
    ]
  })
  queueJson(client, { summary: '实现了但测不过', files: ['x.ts'] })
  // 首次 verify fail
  queueJson(client, {
    allPassed: false,
    pass: 0,
    fail: 1,
    evidence: 'fail',
    failures: ['永远失败'],
    timeout: false
  })
  // 3 次 debug unresolved（不走 re-verify）
  for (let i = 0; i < 3; i++) {
    queueJson(client, {
      status: 'unresolved',
      summary: '仍失败 ' + (i + 1),
      evidence: 'fail',
      tried: ['try'],
      next_steps: ['人工介入']
    })
  }
  // review
  queueJson(client, {
    verdict: 'pass',
    criticalCount: 0,
    highCount: 0,
    criticals: [],
    issues: []
  })
}

/** afterEach 删临时目录：有界退避重试 EBUSY，禁止只靠拉长 vitest timeout */
async function rmTmpDirSafe(dir: string): Promise<void> {
  const delays = [50, 100, 200, 400, 800]
  for (let i = 0; i <= delays.length; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err
      const d = delays[i]
      if (d === undefined) throw err
      await new Promise((r) => setTimeout(r, d))
    }
  }
}

describe('br-full-dev 阶段 D', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-br-full-'))
    await _resetWorkflowRuntimeForTests()
  })

  afterEach(async () => {
    // 先等 scope/child 退出并清理 owned worktree，再删 tmp（修 Windows EBUSY flaky）
    await _resetWorkflowRuntimeForTests()
    await rmTmpDirSafe(tmp)
  })

  it('happy path：写出 specs/plans/reports，askUser 后 pendingCommit', async () => {
    const client = new MockModelClient()
    queueHappyPath(client)
    const deps = makeDeps(tmp, client, {
      askUserResolver: async (req) => {
        // 验收失败后的可选停顿 + 阶段 5 发布确认
        if (req.question.includes('验收失败')) return '跳过并继续'
        return '暂不提交，继续微调'
      }
    })

    const outcome = await runWorkflow({
      engine: 'v1',
      script: 'br-full-dev',
      args: { requirement: '实现一个 Todo CLI' },
      deps,
      runId: '2026-07-04-happy'
    })

    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') return
    expect(outcome.result).toMatchObject({
      status: 'completed',
      pendingCommit: true
    })

    const state = JSON.parse(readFileSync(statePath(tmp), 'utf-8')) as ComposeState
    expect(state.run.status).toBe('completed')
    expect(state.phase?.current).toBe('ship')
    expect(state.artifacts?.spec).toMatch(/\.nova\/compose\/specs\/.*-design\.md$/)
    expect(state.artifacts?.plan).toMatch(/\.nova\/compose\/plans\/.*-plan\.md$/)
    expect(state.artifacts?.report).toMatch(/\.nova\/compose\/reports\/.*\.md$/)
    expect(state.tasks?.[0]?.status).toBe('done')
    expect(state.stats?.done).toBe(1)

    expect(existsSync(join(tmp, state.artifacts!.spec!))).toBe(true)
    expect(existsSync(join(tmp, state.artifacts!.plan!))).toBe(true)
    expect(existsSync(join(tmp, state.artifacts!.report!))).toBe(true)
  })

  it('连续 3 次 verify/debug 失败 → task skipped + verify_failed_3x', async () => {
    const client = new MockModelClient()
    queueVerifyFail3x(client)
    const deps = makeDeps(tmp, client, {
      askUserResolver: async (req) => {
        // 验收失败后的可选停顿 + 阶段 5 发布确认
        if (req.question.includes('验收失败')) return '跳过并继续'
        return '暂不提交，继续微调'
      }
    })

    const outcome = await runWorkflow({
      engine: 'v1',
      script: 'br-full-dev',
      args: { requirement: '必失败需求' },
      deps,
      runId: '2026-07-04-fail3'
    })

    expect(outcome.status).toBe('completed')
    const state = JSON.parse(readFileSync(statePath(tmp), 'utf-8')) as ComposeState
    const task = state.tasks?.find((t) => t.id === 'task-001')
    expect(task?.status).toBe('skipped')
    expect(task?.failure?.reason).toBe('verify_failed_3x')
    expect(task?.attempts).toBe(3)
    expect(state.stats?.skipped).toBe(1)
  })

  it('askUser 真正阻塞，不自动推进', async () => {
    const client = new MockModelClient()
    // 最小脚本：直接 askUser
    const script = `
export const meta = {
  name: "ask-block",
  description: "test askUser block",
  phases: [{ title: "发布" }],
};
phase("发布");
const answer = await askUser({
  question: "是否继续？",
  options: ["是", "否"],
});
return { answer };
`
    const askEvents: { requestId: string; question: string }[] = []
    const deps = makeDeps(tmp, client)
    deps.parentEventBus.on((ev) => {
      if (ev.type === 'workflow_ask_user') {
        askEvents.push({ requestId: ev.requestId, question: ev.question })
      }
    })

    let settled = false
    const runPromise = runWorkflow({
      engine: 'v1',
      script,
      args: {},
      deps,
      runId: '2026-07-04-ask'
    }).then((o) => {
      settled = true
      return o
    })

    // 等事件发出
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)
    expect(getWorkflowStatus('2026-07-04-ask')?.status).toBe('running')
    expect(askEvents.length).toBe(1)

    const ok = resolveWorkflowAskUser('2026-07-04-ask', askEvents[0]!.requestId, '是')
    expect(ok).toBe(true)

    const outcome = await runPromise
    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') {
      expect(outcome.result).toEqual({ answer: '是' })
    }
  })

  it('resume：journal 跳过已成功 agent；script_sha 不匹配需显式 migrate', async () => {
    const client = new MockModelClient()
    // 第一次：简单脚本写 journal
    const scriptV1 = `
export const meta = { name: "resume-test", description: "r", phases: [{ title: "探索" }] };
phase("探索");
const a = await agent("step-a", { label: "a" });
const b = await agent("step-b", { label: "b" });
return { a, b };
`
    queueText(client, 'A1')
    queueText(client, 'B1')
    const deps1 = makeDeps(tmp, client)
    const o1 = await runWorkflow({
      engine: 'v1',
      script: scriptV1,
      deps: deps1,
      runId: '2026-07-04-resume'
    })
    expect(o1.status).toBe('completed')
    expect(existsSync(runJournalPath(tmp, '2026-07-04-resume'))).toBe(true)

    // resume 同脚本：不应再调模型（client 无新响应）
    const client2 = new MockModelClient()
    const deps2 = makeDeps(tmp, client2)
    const o2 = await runWorkflow({
      engine: 'v1',
      script: scriptV1,
      deps: deps2,
      runId: '2026-07-04-resume',
      resume: true
    })
    expect(o2.status).toBe('completed')
    if (o2.status === 'completed') {
      expect(o2.result).toEqual({ a: 'A1', b: 'B1' })
    }

    // 改脚本后 resume：默认拒绝；显式 migrate 才 freshJournal
    const scriptV2 = `
export const meta = { name: "resume-test", description: "r", phases: [{ title: "探索" }] };
phase("探索");
const a = await agent("step-a-changed", { label: "a" });
return { a };
`
    const client3 = new MockModelClient()
    queueText(client3, 'A2')
    const deps3 = makeDeps(tmp, client3)
    const o3 = await runWorkflow({
      engine: 'v1',
      script: scriptV2,
      deps: deps3,
      runId: '2026-07-04-resume',
      resume: true,
      scriptShaMismatch: 'migrate'
    })
    expect(o3.status).toBe('completed')
    if (o3.status === 'completed') {
      expect(o3.result).toEqual({ a: 'A2' })
    }
  })

  it('内置 br-full-dev 脚本已注册且 meta 含五阶段', () => {
    const entry = getBuiltinScript('br-full-dev')
    expect(entry).toBeTruthy()
    expect(entry!.script).toContain('MAX_TDD_ATTEMPTS = 3')
    expect(entry!.script).toContain('askUser')
    expect(entry!.script).toContain('topoSort')
    // 多任务 worktree：verify/debug 必须复用 directory，禁止另开 isolation
    expect(entry!.script).toContain('runVerifyTdd')
    expect(entry!.script).toMatch(/directory:\s*wtDir/)
  })

  it('放弃本次改动：不执行破坏性 Git 回滚，保留工作区改动', async () => {
    // 需要真实 git 仓库（脚本仍会记录 baseline SHA，但不得 reset/clean）
    const git = (args: string[]) => {
      const r = spawnSync('git', args, { cwd: tmp, encoding: 'utf-8', windowsHide: true })
      if (r.status !== 0) throw new Error(r.stderr || r.stdout || args.join(' '))
    }
    git(['init'])
    git(['config', 'user.email', 'test@nova.local'])
    git(['config', 'user.name', 'nova-test'])
    writeFileSync(join(tmp, 'README.md'), '# original\n', 'utf-8')
    git(['add', '.'])
    git(['commit', '-m', 'init'])

    // 模拟编排期间改动了已跟踪文件 + 未跟踪文件
    writeFileSync(join(tmp, 'README.md'), '# dirty-from-compose\n', 'utf-8')
    writeFileSync(join(tmp, 'untracked.txt'), 'should-be-kept\n', 'utf-8')

    const client = new MockModelClient()
    queueHappyPath(client)
    const deps = makeDeps(tmp, client, {
      askUserResolver: async () => '放弃本次改动'
    })

    const outcome = await runWorkflow({
      engine: 'v1',
      script: 'br-full-dev',
      args: { requirement: '实现一个 Todo CLI' },
      deps,
      runId: '2026-07-04-abandon'
    })

    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') {
      expect(outcome.result).toMatchObject({ abandoned: true, reverted: false })
      expect(String((outcome.result as { revertError?: string }).revertError ?? '')).toMatch(
        /已禁用|checkpoint|消息回退/
      )
    }
    // 工作区改动必须保留（禁止 git reset / clean）
    expect(readFileSync(join(tmp, 'README.md'), 'utf-8').replace(/\r\n/g, '\n')).toBe(
      '# dirty-from-compose\n'
    )
    expect(existsSync(join(tmp, 'untracked.txt'))).toBe(true)
    // .nova 编排产物应保留
    const state = JSON.parse(readFileSync(statePath(tmp), 'utf-8')) as ComposeState
    expect(state.artifacts?.report).toBeTruthy()
    expect(existsSync(join(tmp, state.artifacts!.report!))).toBe(true)
  })
})

describe('state schema helpers', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-state-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('updateState 写入 failure 枚举与 stats', async () => {
    const client = new MockModelClient()
    const script = `
export const meta = { name: "state-fail", description: "s", phases: [{ title: "执行" }] };
phase("执行");
updateState({
  tasks: [{ id: "task-001", title: "t", status: "pending" }],
});
updateState({
  failure: {
    taskId: "task-001",
    reason: "verify_failed_3x",
    summary: "三次失败",
    evidence: "err",
    status: "skipped",
    attempts: 3,
  },
});
return loadState();
`
    const deps = makeDeps(tmp, client)
    const outcome = await runWorkflow({
      engine: 'v1',
      script,
      deps,
      runId: '2026-07-04-state'
    })
    expect(outcome.status).toBe('completed')
    const state = JSON.parse(readFileSync(statePath(tmp), 'utf-8')) as ComposeState
    expect(state.tasks?.[0]?.status).toBe('skipped')
    expect(state.tasks?.[0]?.failure?.reason).toBe('verify_failed_3x')
    expect(state.stats?.skipped).toBe(1)
  })
})
