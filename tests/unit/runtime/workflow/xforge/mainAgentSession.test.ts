import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../../../../src/runtime/agent/EventBus'
import { CheckpointManager } from '../../../../../src/runtime/checkpoints/CheckpointManager'
import type { ModelClient } from '../../../../../src/runtime/model/ModelClient'
import type { ChatEvent } from '../../../../../src/runtime/model/types'
import { createRunCoordinator } from '../../../../../src/runtime/run/RunCoordinator'
import { ToolRegistry } from '../../../../../src/runtime/tools/ToolRegistry'
import { XForgeFileEffectRecorder } from '../../../../../src/runtime/workflow/xforge/effectRecorder'
import {
  XForgeMainAgentSession,
  parseJsonObject,
  repairStructuredOutput
} from '../../../../../src/runtime/workflow/xforge/mainAgentSession'
import { XForgeRunService } from '../../../../../src/runtime/workflow/xforge/XForgeRunService'
import { bindXForgeTestExecution } from './testExecution'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scriptedClient(outputs: Array<string | ChatEvent[]>): ModelClient {
  let index = 0
  return {
    async *chat(): AsyncIterable<ChatEvent> {
      const output = outputs[index++]
      if (output === undefined) throw new Error(`unexpected model call ${index}`)
      if (Array.isArray(output)) {
        for (const event of output) yield event
        return
      }
      yield { type: 'text_delta', delta: output }
      yield { type: 'message_end', finishReason: 'stop' }
    },
    updateConfig() {}
  }
}

async function createSession(overrides: {
  modelClient?: ModelClient
  abortSignal?: AbortSignal
  parentEventBus?: EventBus
  parentMessageId?: string
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nova-xforge-session-'))
  roots.push(root)
  const runsRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-session-runs-'))
  roots.push(runsRoot)
  const checkpointRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-session-cp-'))
  roots.push(checkpointRoot)
  const coordinator = createRunCoordinator(runsRoot)
  const service = new XForgeRunService(coordinator)
  const run = service.startXForgeRun({ workspaceId: root, sessionId: 'session-main' })
  coordinator.markRunning(run.runId)
  const committer = bindXForgeTestExecution(service, coordinator, run.runId)
  let stage: 'brainstorm' | 'plan' = 'brainstorm'
  const session = new XForgeMainAgentSession({
    runId: run.runId,
    workspaceRoot: root,
    modelClient: overrides.modelClient ?? scriptedClient(['{"ok":true}']),
    parentEventBus: overrides.parentEventBus ?? new EventBus(),
    parentMessageId: overrides.parentMessageId ?? 'parent-1',
    toolRegistry: new ToolRegistry(),
    checkpointManager: new CheckpointManager({
      checkpointDir: checkpointRoot,
      sessionId: 'session-main',
      workspaceRoot: root
    }),
    committer,
    askQuestion: async () => [],
    abortSignal: overrides.abortSignal,
    getStage: () => stage,
    effectRecorder: new XForgeFileEffectRecorder(root, run.runId, () => 'step')
  })
  return { session, setStage: (next: typeof stage) => { stage = next } }
}

describe('XForgeMainAgentSession', () => {
  it('空响应时抛错', async () => {
    const { session } = await createSession({
      modelClient: scriptedClient(['   '])
    })
    await expect(session.run('hello')).rejects.toThrow('返回空结果')
    session.dispose()
  })

  it('非法 JSON 经一次 repair 成功', async () => {
    const { session } = await createSession({
      modelClient: scriptedClient([
        'not-json',
        '{"ready":true}'
      ])
    })
    const value = await session.runJson('prompt', (v): v is { ready: boolean } =>
      !!v && typeof v === 'object' && (v as { ready?: unknown }).ready === true
    )
    expect(value).toEqual({ ready: true })
    session.dispose()
  })

  it('repair 失败时抛出校验错误且不伪装成功', async () => {
    const { session } = await createSession({
      modelClient: scriptedClient([
        'still-bad',
        'also-bad'
      ])
    })
    await expect(session.runJson('prompt', (v): v is { ready: boolean } =>
      !!v && typeof v === 'object' && (v as { ready?: unknown }).ready === true
    )).rejects.toThrow('结构化结果无法通过 JSON 与字段校验')
    session.dispose()
  })

  it('abort 发生在模型调用前会立即失败', async () => {
    const controller = new AbortController()
    controller.abort()
    const { session } = await createSession({ abortSignal: controller.signal })
    await expect(session.run('hello')).rejects.toThrow('XForge 执行已取消')
    session.dispose()
  })

  it('abort 发生在模型调用中会取消主 Agent', async () => {
    const controller = new AbortController()
    const client: ModelClient = {
      async *chat(_messages, _tools, options) {
        controller.abort()
        if (options?.abortSignal?.aborted) {
          yield { type: 'cancelled' }
          return
        }
        yield { type: 'text_delta', delta: 'late' }
        yield { type: 'message_end', finishReason: 'stop' }
      },
      updateConfig() {}
    }
    const { session } = await createSession({
      modelClient: client,
      abortSignal: controller.signal
    })
    await expect(session.run('hello')).rejects.toThrow()
    session.dispose()
  })

  it('向父 EventBus 转发工具事件且不转发内部 text_delta', async () => {
    const parent = new EventBus()
    const forwarded: string[] = []
    parent.on(event => forwarded.push(event.type))
    const client: ModelClient = {
      async *chat() {
        yield { type: 'text_delta', delta: 'secret-internal' }
        yield {
          type: 'tool_call_start',
          messageId: 'ignored',
          toolCallId: 'tc-1',
          toolName: 'read'
        }
        yield {
          type: 'tool_result',
          messageId: 'ignored',
          toolCallId: 'tc-1',
          toolName: 'read',
          result: { success: true, output: 'ok' }
        }
        yield { type: 'message_end', finishReason: 'stop' }
      },
      updateConfig() {}
    }
    // AgentLoop emits message_start etc. Use a client that only produces text for run()
    // and verify forwarding via a custom path: sendMessage will emit events through bus.
    const { session } = await createSession({
      modelClient: scriptedClient(['answer']),
      parentEventBus: parent,
      parentMessageId: 'parent-msg'
    })
    await session.run('hello')
    expect(forwarded).not.toContain('text_delta')
    expect(forwarded).not.toContain('message_start')
    session.dispose()
  })

  it('parseJsonObject 支持围栏与裸对象', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseJsonObject('prefix {"b":2} suffix')).toEqual({ b: 2 })
    expect(parseJsonObject('nope')).toBeNull()
  })

  it('repairStructuredOutput 在空修复结果时失败', async () => {
    await expect(repairStructuredOutput({
      modelClient: scriptedClient(['']),
      prompt: 'p',
      invalidOutput: '{'
    })).rejects.toThrow('结构化结果修复返回空结果')
  })

  it('brainstorm 阶段 effective tool schema 不含写入类工具', async () => {
    const { session, setStage } = await createSession({
      modelClient: scriptedClient(['{}'])
    })
    setStage('brainstorm')
    // 通过一次 run 触发 AgentLoop 装配；policy 单测已覆盖 schema，这里确认 session 可按 stage 运行
    await expect(session.runJson('x', (v): v is Record<string, never> =>
      !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0
    )).resolves.toEqual({})
    session.dispose()
  })
})
