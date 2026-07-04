import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import {
  runWorkflow,
  cancelWorkflow,
  listWorkflows,
  _resetWorkflowRuntimeForTests
} from '../../../../src/runtime/workflow/runtime'
import { statePath, runLogPath } from '../../../../src/runtime/workflow/paths'
import type { WorkflowRuntimeDeps } from '../../../../src/runtime/workflow/types'
import type { ToolResult } from '../../../../src/runtime/tools/types'
import type { ComposeState } from '../../../../src/runtime/workflow/types'

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

/** smoke.js 调 3 次 agent，每次给一段文本 */
function prepareSmokeClient(client: MockModelClient): void {
  for (const text of ['hello', 'world', 'summary']) {
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: text },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
  }
}

describe('workflow runtime', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-wf-rt-'))
    _resetWorkflowRuntimeForTests()
  })

  afterEach(() => {
    _resetWorkflowRuntimeForTests()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('跑通 smoke.js，落盘 log.txt 与 state.json', async () => {
    const client = new MockModelClient()
    prepareSmokeClient(client)
    const phases: string[] = []
    const logs: string[] = []
    const deps = makeDeps(tmp, client)
    deps.parentEventBus.on((ev) => {
      if (ev.type === 'workflow_phase') phases.push(ev.phase)
      if (ev.type === 'workflow_log') logs.push(ev.message)
    })

    const outcome = await runWorkflow({
      script: 'smoke',
      args: { task: 'smoke-test' },
      deps,
      runId: '2026-07-04-smoke'
    })

    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') return
    expect(outcome.result).toMatchObject({
      ok: true,
      a1: 'hello',
      a2: 'world',
      a3: 'summary',
      marker: 'ok'
    })

    const logFile = runLogPath(tmp, '2026-07-04-smoke')
    expect(existsSync(logFile)).toBe(true)
    const logText = readFileSync(logFile, 'utf-8')
    expect(logText).toContain('smoke start')

    const stateFile = statePath(tmp)
    expect(existsSync(stateFile)).toBe(true)
    const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as ComposeState
    expect(state.run.id).toBe('2026-07-04-smoke')
    expect(state.run.status).toBe('completed')
    expect(state.run.script).toBe('smoke')
    expect(state.phase?.current).toBe('two')

    expect(phases).toEqual(['one', 'two'])
    expect(logs.some((l) => l.includes('smoke start'))).toBe(true)
  })

  it('内联脚本可直接跑', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'inline-ok' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const script = `
export const meta = { name: "inline-demo", description: "inline" };
phase("p1");
const r = await agent("go");
return { r };
`
    const outcome = await runWorkflow({
      script,
      deps: makeDeps(tmp, client),
      runId: 'inline-1'
    })
    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') {
      expect(outcome.result).toEqual({ r: 'inline-ok' })
    }
  })

  it('cancelWorkflow 将状态标为 cancelled', async () => {
    const client = new MockModelClient()
    // agent 挂起，便于中途 cancel
    const hanging = new MockModelClient()
    hanging.chat = async function* () {
      await new Promise(() => {})
      yield { type: 'message_start' as const }
    }

    const script = `
export const meta = { name: "cancel-demo", description: "cancel" };
await agent("hang");
return { done: true };
`
    const runPromise = runWorkflow({
      script,
      deps: makeDeps(tmp, hanging),
      runId: 'cancel-1',
      deadlineMs: 30_000
    })

    // 等 run 进入 active
    await new Promise((r) => setTimeout(r, 50))
    expect(listWorkflows().some((w) => w.runId === 'cancel-1')).toBe(true)
    expect(cancelWorkflow('cancel-1')).toBe(true)

    const outcome = await runPromise
    expect(outcome.status).toBe('cancelled')

    const state = JSON.parse(readFileSync(statePath(tmp), 'utf-8')) as ComposeState
    expect(state.run.status).toBe('cancelled')

    // 避免 unused
    void client
  }, 15_000)

  it('脚本逻辑错误 → failed', async () => {
    const script = `
export const meta = { name: "fail-demo", description: "fail" };
throw new Error("boom");
`
    const outcome = await runWorkflow({
      script,
      deps: makeDeps(tmp, new MockModelClient()),
      runId: 'fail-1'
    })
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.error).toMatch(/boom/)
    }
  })
})
