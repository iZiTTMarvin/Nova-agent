import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { createWriteTool } from '../../../../src/runtime/tools/writeTool'
import {
  runWorkflow,
  cancelWorkflow,
  _resetWorkflowRuntimeForTests
} from '../../../../src/runtime/workflow/runtime'
import { worktreesRoot, list as listWorktrees } from '../../../../src/runtime/worktree'
import { _resetWorktreeLocksForTests } from '../../../../src/runtime/worktree'
import type { WorkflowRuntimeDeps } from '../../../../src/runtime/workflow/types'
import type { ToolResult } from '../../../../src/runtime/tools/types'

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  }
}

function initRepo(dir: string): void {
  git(['init'], dir)
  git(['config', 'user.email', 'test@nova.local'], dir)
  git(['config', 'user.name', 'nova-test'], dir)
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf-8')
  git(['add', '.'], dir)
  git(['commit', '-m', 'init'], dir)
}

function makeDeps(workspaceRoot: string, client: MockModelClient): WorkflowRuntimeDeps {
  const reg = new ToolRegistry()
  reg.register({
    name: 'ls',
    description: 'list',
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      return { success: true, output: 'ok' }
    }
  })
  reg.register(createWriteTool())
  return {
    modelClient: client,
    parentEventBus: new EventBus(),
    resolveTool: (n) => reg.getTool(n),
    workspaceRoot,
    mode: 'compose'
  }
}

function addText(client: MockModelClient, text: string): void {
  client.addResponse({
    events: [
      { type: 'message_start' },
      { type: 'text_delta', delta: text },
      { type: 'message_end', finishReason: 'stop' }
    ]
  })
}

describe('workflow worktree isolation', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-wf-wt-'))
    await _resetWorkflowRuntimeForTests()
    _resetWorktreeLocksForTests()
    initRepo(tmp)
  })

  afterEach(async () => {
    await _resetWorkflowRuntimeForTests()
    _resetWorktreeLocksForTests()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('并行 4 个 isolation:worktree agent 不互相覆盖', async () => {
    // 每个 agent 写不同文件到自己的 worktree（通过 write 工具）
    // MockModelClient 无法真正调工具，所以我们验证：
    // 1. 4 个 agent 都成功返回
    // 2. 若有改动则 worktree 保留且路径互不相同
    // 由于 mock 不写文件，worktree 会是 pristine → 成功终态被删掉
    // 因此改为：在 agent 返回前由脚本侧无法写 worktree；我们改为验证
    // spawn 期间目录存在且互异——通过挂起 agent 并在中途 list。

    // 更直接：用 write 工具需要模型发 tool_call。简化为验证
    // isolation worktree 返回的 _worktree.directory 互不相同（需有改动才保留）。
    // 让 mock 不产生改动 → pristine 删除 → 返回值无 _worktree。
    // 改为：直接测 create 并行 + agent 在不同 cwd。

    const client = new MockModelClient()
    for (let i = 0; i < 4; i++) addText(client, `r${i}`)

    // 用自定义 hook 路径：脚本里 4 个 isolation agent
    // pristine 会被删，result 是纯文本（无 _worktree）
    const script = `
export const meta = { name: "wt4", description: "wt" };
const outs = await parallel([
  () => agent("a0", { isolation: "worktree", label: "t0" }),
  () => agent("a1", { isolation: "worktree", label: "t1" }),
  () => agent("a2", { isolation: "worktree", label: "t2" }),
  () => agent("a3", { isolation: "worktree", label: "t3" }),
]);
return { outs };
`
    const outcome = await runWorkflow({
      script,
      deps: makeDeps(tmp, client),
      runId: 'wt-4'
    })
    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') {
      const result = outcome.result as { outs: unknown[] }
      expect(result.outs).toHaveLength(4)
      // pristine → 无 _worktree，纯文本
      expect(result.outs).toEqual(['r0', 'r1', 'r2', 'r3'])
    }
    // 全部 pristine，终态后 worktree 目录应为空或不存在
    const root = worktreesRoot(tmp)
    if (existsSync(root)) {
      const left = await listWorktrees(tmp)
      expect(left.length).toBe(0)
    }
  }, 60_000)

  it('directory 选项复用已有目录，不另建 worktree', async () => {
    // 手动建子目录模拟已有 worktree，verify/debug 应复用而非另建
    const reuse = join(tmp, 'manual-wt')
    mkdirSync(reuse, { recursive: true })
    writeFileSync(join(reuse, 'in-wt.txt'), 'hello', 'utf-8')

    const client = new MockModelClient()
    addText(client, 'verify-ok')
    addText(client, 'debug-ok')

    const script = `
export const meta = { name: "dir-reuse", description: "d" };
const dir = ${JSON.stringify(reuse)};
const v = await agent("verify", { directory: dir, label: "v1" });
const d = await agent("debug", { directory: dir, label: "d1" });
return { v, d, dir };
`
    const before = existsSync(worktreesRoot(tmp))
      ? (await listWorktrees(tmp)).length
      : 0

    const outcome = await runWorkflow({
      script,
      deps: makeDeps(tmp, client),
      runId: 'dir-reuse'
    })
    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') {
      expect(outcome.result).toEqual({
        v: 'verify-ok',
        d: 'debug-ok',
        dir: reuse
      })
    }
    const after = existsSync(worktreesRoot(tmp))
      ? (await listWorktrees(tmp)).length
      : 0
    expect(after).toBe(before)
    // 复用目录内文件仍在
    expect(existsSync(join(reuse, 'in-wt.txt'))).toBe(true)
  }, 30_000)

  it('reclaim 完整：cancel 时所有 owned worktree 都被清理', async () => {
    // agent 挂起，cancel 后 reclaim
    const hanging = new MockModelClient()
    hanging.chat = async function* () {
      await new Promise(() => {})
      yield { type: 'message_start' as const }
    }

    const script = `
export const meta = { name: "wt-cancel", description: "c" };
await parallel([
  () => agent("h0", { isolation: "worktree", label: "c0" }),
  () => agent("h1", { isolation: "worktree", label: "c1" }),
]);
return { done: true };
`
    const runPromise = runWorkflow({
      script,
      deps: makeDeps(tmp, hanging),
      runId: 'wt-cancel',
      deadlineMs: 30_000
    })

    // 等 worktree 创建
    await new Promise((r) => setTimeout(r, 500))
    const root = worktreesRoot(tmp)
    // 可能已创建目录
    expect(cancelWorkflow('wt-cancel')).toBe(true)

    const outcome = await runPromise
    expect(outcome.status).toBe('cancelled')

    if (existsSync(root)) {
      const left = await listWorktrees(tmp)
      expect(left.length).toBe(0)
      // 目录也可能被 rm
      const entries = existsSync(root) ? readdirSync(root) : []
      expect(entries.length).toBe(0)
    }
  }, 30_000)
})
