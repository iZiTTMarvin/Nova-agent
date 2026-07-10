import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import {
  runWorkflow,
  _resetWorkflowRuntimeForTests
} from '../../../../src/runtime/workflow/runtime'
import { _resetGlobalSemaphoreForTests } from '../../../../src/runtime/workflow/semaphore'
import type { WorkflowRuntimeDeps } from '../../../../src/runtime/workflow/types'
import type { ModelClient, ChatOptions } from '../../../../src/runtime/model/ModelClient'
import type { ChatMessage, ChatEvent, ToolDefinition, ModelClientConfig } from '../../../../src/runtime/model/types'
import type { ToolResult } from '../../../../src/runtime/tools/types'

/** 可观测并发的 mock client：chat 挂起一小段时间并统计同时活跃数 */
class ConcurrentProbeClient implements ModelClient {
  active = 0
  maxActive = 0
  private config: ModelClientConfig = { baseUrl: '', apiKey: '', modelId: '' }

  async *chat(
    _messages: ChatMessage[],
    _tools?: ToolDefinition[],
    _options?: ChatOptions
  ): AsyncIterable<ChatEvent> {
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    await new Promise((r) => setTimeout(r, 40))
    this.active--
    yield { type: 'message_start' }
    yield { type: 'text_delta', delta: 'ok' }
    yield { type: 'message_end', finishReason: 'stop' }
  }

  updateConfig(config: ModelClientConfig): void {
    this.config = config
  }
}

function makeDeps(workspaceRoot: string, client: ModelClient): WorkflowRuntimeDeps {
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

describe('workflow parallel', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-wf-par-'))
    await _resetWorkflowRuntimeForTests()
    _resetGlobalSemaphoreForTests(16)
  })

  afterEach(async () => {
    await _resetWorkflowRuntimeForTests()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('20 个 thunk 并发，max=16 时只有 16 个同时 active', async () => {
    const client = new ConcurrentProbeClient()
    // 生成 20 个不同 prompt，避免 journal 命中
    const prompts = Array.from({ length: 20 }, (_, i) => `task-${i}`)
    const script = `
export const meta = { name: "par", description: "parallel" };
const prompts = ${JSON.stringify(prompts)};
const outs = await parallel(prompts.map((p) => () => agent(p)));
return { n: outs.length };
`
    const outcome = await runWorkflow({
      script,
      deps: makeDeps(tmp, client),
      runId: 'par-20',
      maxConcurrentAgents: 16
    })
    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') {
      expect(outcome.result).toEqual({ n: 20 })
    }
    expect(client.maxActive).toBeLessThanOrEqual(16)
    expect(client.maxActive).toBe(16)
  }, 30_000)
})
