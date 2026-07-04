import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { createHostHooks, type HookContext } from '../../../../src/runtime/workflow/hooks'
import { makeRunSemaphore } from '../../../../src/runtime/workflow/semaphore'
import type { WorkflowRuntimeDeps } from '../../../../src/runtime/workflow/types'
import type { ToolResult } from '../../../../src/runtime/tools/types'

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
  return {
    modelClient: client,
    parentEventBus: new EventBus(),
    resolveTool: (n) => reg.getTool(n),
    workspaceRoot,
    mode: 'compose'
  }
}

function makeCtx(deps: WorkflowRuntimeDeps, abort?: AbortController): HookContext {
  const ac = abort ?? new AbortController()
  const { runSem, globalSem } = makeRunSemaphore(4)
  return {
    runId: 'test-run',
    deps,
    abortSignal: ac.signal,
    currentPhase: { name: '' },
    onPhase: () => {},
    onLog: () => {},
    journal: { results: new Map(), pass: 1 },
    occ: new Map(),
    runSem,
    globalSem,
    ownedWorktrees: new Map(),
    composeState: {
      run: {
        id: 'test-run',
        command: 'test',
        script: 'test',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'running'
      }
    },
    pendingAskUsers: new Map(),
    persistState: () => {}
  }
}

describe('workflow agent hook', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-wf-agent-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('成功时返回摘要文本', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'hello-agent' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const hooks = createHostHooks(makeCtx(makeDeps(tmp, client)))
    const result = await hooks.agent!('do work')
    expect(result).toBe('hello-agent')
  })

  it('模型无输出时返回 null', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const hooks = createHostHooks(makeCtx(makeDeps(tmp, client)))
    const result = await hooks.agent!('empty')
    expect(result).toBeNull()
  })

  it('取消时返回 null', async () => {
    const client = new MockModelClient()
    // 永不结束的响应：不 addResponse，chat 会 yield 空
    // 用已 abort 的 signal
    const ac = new AbortController()
    ac.abort()
    const hooks = createHostHooks(makeCtx(makeDeps(tmp, client), ac))
    const result = await hooks.agent!('cancelled')
    expect(result).toBeNull()
  })

  it('超时返回 null', async () => {
    const client = new MockModelClient()
    // chat 挂起直到 abort
    client.chat = async function* () {
      await new Promise(() => {
        /* never settle */
      })
      yield { type: 'message_start' }
    }
    const hooks = createHostHooks(makeCtx(makeDeps(tmp, client)))
    const result = await hooks.agent!('slow', { timeoutMs: 50 })
    expect(result).toBeNull()
  }, 10_000)

  it('schema 模式解析 JSON 对象', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '{"title":"t","body":"b"}' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const hooks = createHostHooks(makeCtx(makeDeps(tmp, client)))
    const result = await hooks.agent!('structured', {
      schema: {
        type: 'object',
        properties: { title: { type: 'string' }, body: { type: 'string' } }
      }
    })
    expect(result).toEqual({ title: 't', body: 'b' })
  })

  it('schema 解析失败返回 null', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'not-json-at-all' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const hooks = createHostHooks(makeCtx(makeDeps(tmp, client)))
    const result = await hooks.agent!('bad', {
      schema: { type: 'object', properties: { x: { type: 'string' } } }
    })
    expect(result).toBeNull()
  })

  it('directory 选项在指定目录执行且不新建 worktree', async () => {
    const sub = join(tmp, 'reuse-wt')
    mkdirSync(sub, { recursive: true })
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'in-reuse-dir' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const hooks = createHostHooks(makeCtx(makeDeps(tmp, client)))
    const result = await hooks.agent!('continue', {
      directory: sub,
      label: 'verify-reuse'
    })
    expect(result).toBe('in-reuse-dir')
    // 不应在 .nova/worktrees 下创建新目录
    const wtRoot = join(tmp, '.nova', 'worktrees')
    expect(existsSync(wtRoot)).toBe(false)
  })
})
