/**
 * host 层测试脚手架：构造一个可控的 HostContext。
 * 真实依赖只保留 TaskScope / journal，子代理端口和模型输出可控。
 */
import { EventBus } from '../../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../../src/runtime/tools/ToolRegistry'
import { TaskScope } from '../../../../../src/runtime/workflow/scheduling/TaskScope'
import type { HostContext } from '../../../../../src/runtime/workflow/host/types'
import type { AgentEvent } from '../../../../../src/runtime/agent/types'
import type { ToolExecutor } from '../../../../../src/runtime/tools/types'
import { selectStructuredResult } from '../../../../../src/runtime/subagents'
import type { SpawnSubagentPort } from '../../../../../src/runtime/subagents'
import type { SpawnSubagentCommand } from '../../../../../src/shared/subagents'

export interface HostTestHarness {
  ctx: HostContext
  scope: TaskScope
  events: AgentEvent[]
  client: MockModelClient
  registry: ToolRegistry
  spawnCommands: SpawnSubagentCommand[]
}

export function makeHostHarness(
  workspaceRoot: string,
  options: {
    autoMode?: boolean
    runId?: string
    tools?: ToolExecutor[]
    spawnSubagentPort?: SpawnSubagentPort
  } = {}
): HostTestHarness {
  const client = new MockModelClient()
  const registry = new ToolRegistry()
  for (const tool of options.tools ?? []) registry.register(tool)

  const events: AgentEvent[] = []
  const eventBus = new EventBus()
  eventBus.on((event) => events.push(event))

  const scope = new TaskScope({ label: 'host-test' })
  const spawnCommands: SpawnSubagentCommand[] = []
  const spawnSubagentPort: SpawnSubagentPort = options.spawnSubagentPort ?? {
    spawn: async (command) => {
      spawnCommands.push(command)
      let summary = ''
      for await (const event of client.chat([{ role: 'user', content: command.task }])) {
        if (event.type === 'text_delta') summary += event.delta
      }
      const finalText = summary.trim()
      // 与真实端口一致：结构化结果在截断前从完整文本解析，而不是由调用方解析 summary
      const structuredResult = command.resultSchema === undefined
        ? undefined
        : selectStructuredResult(command.resultSchema, finalText)
      return {
        childSessionId: `child-session-${spawnCommands.length}`,
        childRunId: `child-run-${spawnCommands.length}`,
        status: finalText ? 'completed' : 'failed',
        summary: finalText,
        ...(structuredResult ? { structuredResult } : {}),
        artifactIds: [],
        startedAt: 1,
        completedAt: 2,
        ...(!finalText
          ? { failure: { code: 'model' as const, message: 'empty-output' } }
          : {})
      }
    }
  }

  const ctx: HostContext = {
    runId: options.runId ?? 'test-run',
    workspaceRoot,
    sessionId: 'sess-1',
    parentRunId: 'parent-run',
    parentMessageId: 'parent-message',
    parentToolCallId: 'parent-tool',
    spawnSubagentPort,
    scope,
    scopeGeneration: scope.captureGeneration(),
    abortSignal: scope.signal,
    eventBus,
    mode: 'compose',
    autoMode: options.autoMode ?? false,
    journal: { results: new Map(), childRefs: new Map(), pass: 1 },
    occ: new Map(),
    ownedWorktrees: new Map(),
    worktreeKeys: new Map(),
    currentPhase: { name: 'test-phase' }
  }

  return { ctx, scope, events, client, registry, spawnCommands }
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
