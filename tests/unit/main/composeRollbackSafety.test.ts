/**
 * 阶段 0 护栏：Compose 回滚不得对用户工作区执行破坏性 Git 命令。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { EventBus } from '../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../src/runtime/tools/ToolRegistry'
import {
  runWorkflow,
  _resetWorkflowRuntimeForTests
} from '../../../src/runtime/workflow/runtime'
import type { WorkflowRuntimeDeps } from '../../../src/runtime/workflow/types'
import type { ToolResult } from '../../../src/runtime/tools/types'

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

function queueJson(client: MockModelClient, obj: unknown): void {
  client.addResponse({
    events: [
      { type: 'message_start' },
      { type: 'text_delta', delta: JSON.stringify(obj) },
      { type: 'message_end', finishReason: 'stop' }
    ]
  })
}

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

describe('P0-1 Compose 回滚安全护栏', () => {
  it('composeHandler 可执行路径不得再对用户工作区执行 git reset --hard / git clean -fd', () => {
    const src = readFileSync(
      join(__dirname, '../../../src/main/ipc/composeHandler.ts'),
      'utf-8'
    )
    // 允许注释中写禁令说明；只检查可执行代码行
    const executable = src
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
      .join('\n')
    expect(executable).not.toMatch(/git\s+reset\s+--hard/)
    expect(executable).not.toMatch(/git\s+clean\s+-fd/)
  })

  it('br-full-dev 可执行路径不得再拼接破坏性 Git 回滚命令', () => {
    const src = readFileSync(
      join(__dirname, '../../../src/runtime/workflow/builtin/br-full-dev.js'),
      'utf-8'
    )
    const executable = src
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
      .join('\n')
    expect(executable).not.toMatch(/git reset --hard/)
    expect(executable).not.toMatch(/git clean -fd/)
  })
})

describe('P0-1 放弃本次改动：不得删除未跟踪/无关文件', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-rollback-safety-'))
    await _resetWorkflowRuntimeForTests()
  })

  afterEach(async () => {
    await _resetWorkflowRuntimeForTests()
    await rmTmpDirSafe(tmp)
  })

  it('放弃后未跟踪文件与用户无关修改必须保留', async () => {
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

    // 编排期间改动 + 用户未跟踪文件 + 用户后续已跟踪修改
    writeFileSync(join(tmp, 'README.md'), '# dirty-from-compose\n', 'utf-8')
    writeFileSync(join(tmp, 'untracked.txt'), 'user-untracked\n', 'utf-8')
    writeFileSync(join(tmp, 'user-extra.md'), '# user parallel\n', 'utf-8')
    git(['add', 'user-extra.md'])
    git(['commit', '-m', 'user parallel'])
    writeFileSync(join(tmp, 'user-extra.md'), '# user edited again\n', 'utf-8')

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
      runId: '2026-07-10-abandon-safe'
    })

    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') {
      expect(outcome.result).toMatchObject({ abandoned: true, reverted: false })
    }

    // 未跟踪文件不得被删
    expect(existsSync(join(tmp, 'untracked.txt'))).toBe(true)
    expect(readFileSync(join(tmp, 'untracked.txt'), 'utf-8')).toContain('user-untracked')
    // 用户后续修改不得被硬重置覆盖
    expect(readFileSync(join(tmp, 'user-extra.md'), 'utf-8').replace(/\r\n/g, '\n')).toBe(
      '# user edited again\n'
    )
  }, 60_000)
})
