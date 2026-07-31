/**
 * host 层测试脚手架：构造一个可控的 HostContext。
 * 真实依赖只保留 TaskScope / 信号量 / journal，模型与工具用 mock。
 */
import { EventBus } from '../../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../../src/runtime/tools/ToolRegistry'
import { TaskScope } from '../../../../../src/runtime/workflow/scheduling/TaskScope'
import { makeRunSemaphore } from '../../../../../src/runtime/workflow/scheduling/semaphore'
import type { HostContext } from '../../../../../src/runtime/workflow/host/types'
import type { AgentEvent } from '../../../../../src/runtime/agent/types'
import type { ToolExecutor } from '../../../../../src/runtime/tools/types'

export interface HostTestHarness {
  ctx: HostContext
  scope: TaskScope
  events: AgentEvent[]
  client: MockModelClient
  registry: ToolRegistry
}

export function makeHostHarness(
  workspaceRoot: string,
  options: {
    autoMode?: boolean
    runId?: string
    tools?: ToolExecutor[]
  } = {}
): HostTestHarness {
  const client = new MockModelClient()
  const registry = new ToolRegistry()
  for (const tool of options.tools ?? []) registry.register(tool)

  const events: AgentEvent[] = []
  const eventBus = new EventBus()
  eventBus.on((event) => events.push(event))

  const scope = new TaskScope({ label: 'host-test' })
  const { runSem, globalSem } = makeRunSemaphore(4)

  const ctx: HostContext = {
    runId: options.runId ?? 'test-run',
    workspaceRoot,
    sessionId: 'sess-1',
    scope,
    scopeGeneration: scope.captureGeneration(),
    abortSignal: scope.signal,
    eventBus,
    modelClient: client,
    resolveTool: (name) => registry.getTool(name),
    mode: 'compose',
    autoMode: options.autoMode ?? false,
    journal: { results: new Map(), pass: 1 },
    occ: new Map(),
    runSem,
    globalSem,
    ownedWorktrees: new Map(),
    worktreeKeys: new Map(),
    currentPhase: { name: 'test-phase' }
  }

  return { ctx, scope, events, client, registry }
}

/** 让 MockModelClient 回一段纯文本 */
export function addTextResponse(client: MockModelClient, text: string): void {
  client.addResponse({
    events: [
      { type: 'message_start' },
      { type: 'text_delta', delta: text },
      { type: 'message_end', finishReason: 'stop' }
    ]
  })
}

/** 空响应：用于验证 never-throw 的「无产出 → null」分支 */
export function addEmptyResponse(client: MockModelClient): void {
  client.addResponse({
    events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
  })
}
