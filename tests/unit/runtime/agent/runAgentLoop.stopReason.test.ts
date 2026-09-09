/**
 * runAgentLoop 停止原因直测（终态诚实的 kernel 层护栏）。
 *
 * AgentLoop 门面恒接线 StopPolicyExtension，max_rounds 由停止策略先行触发；
 * while 循环条件耗尽（无停止策略时的回退路径）与自然收工只能直测 kernel：
 * - 循环条件耗尽 → stopReason 'max_rounds'
 * - 模型无工具调用 break → 不设 stopReason
 * - 批次后 signal 置位 → cancelled，不设 stopReason
 */
import { describe, it, expect } from 'vitest'
import { runAgentLoop } from '../../../../src/runtime/agent/core/runAgentLoop'
import { StreamProcessor } from '../../../../src/runtime/agent/stream/StreamProcessor'
import { ModelClientPool } from '../../../../src/runtime/model/ModelClientPool'
import { RecoveryStateMachine } from '../../../../src/runtime/agent/recovery/RecoveryStateMachine'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import { HookManager } from '../../../../src/runtime/agent/core/HookManager'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { createAgentContext } from '../../../../src/runtime/agent/core/AgentContext'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import type { AgentEvent } from '../../../../src/runtime/agent/types'
import type { ChatEvent } from '../../../../src/runtime/model/types'
import type { ToolBatchExecutionResult } from '../../../../src/runtime/agent/execution/toolBatchExecutor'
import type { AgentLoopConfig as LoopConfig } from '../../../../src/runtime/agent/core/loopTypes'
import { createAssistantCompletionPolicy } from '../../../../src/runtime/agent/assistantCompletionPolicy'

/** 构造最小可用 AgentContext（native 方言，不触发 XML scanner） */
function createNativeContext() {
  return createAgentContext({
    dialect: 'native',
    mode: 'default',
    readState: createReadState(),
    messages: [{ role: 'user', content: 'hi' }]
  })
}

function toolCallResponse(toolCallId: string): { events: ChatEvent[] } {
  return {
    events: [
      { type: 'message_start' },
      { type: 'tool_call_start', toolCallId, toolName: 'ls', index: 0 },
      { type: 'tool_call', toolCall: { id: toolCallId, name: 'ls', arguments: '{}' } },
      { type: 'message_end', finishReason: 'tool_calls' }
    ]
  }
}

function textResponse(): { events: ChatEvent[] } {
  return {
    events: [
      { type: 'message_start' },
      { type: 'text_delta', delta: '好的' },
      { type: 'message_end', finishReason: 'stop' }
    ]
  }
}

function reasoningOnlyResponse(): { events: ChatEvent[] } {
  return {
    events: [
      { type: 'message_start' },
      { type: 'thinking_delta', delta: '内部推理' },
      { type: 'message_end', finishReason: 'stop' }
    ]
  }
}

/** 直测内核：不接停止策略（AgentLoop 门面才接线），暴露循环条件自身的退出路径 */
async function runKernel(
  client: MockModelClient,
  maxToolRounds: number,
  opts: {
    signal?: () => boolean
    executeBatch?: () => Promise<ToolBatchExecutionResult>
    onToolResultCommitted?: () => void
    assistantCompletionPolicy?: LoopConfig['assistantCompletionPolicy']
  } = {}
) {
  const modelPool = new ModelClientPool({
    primary: client,
    primaryConfig: { baseUrl: 'http://test', apiKey: 'test', modelId: 'test-model' }
  })
  const processor = new StreamProcessor({
    modelPool,
    recovery: new RecoveryStateMachine(),
    cacheDiagnostics: new CacheDiagnostics(),
    emit: () => {},
    emitContextBreakdown: () => {},
    runOverflowCompaction: () => Promise.resolve(false),
    hookManager: new HookManager()
  })
  const context = createNativeContext()
  const signal = opts.signal ?? (() => false)
  const executeBatch = opts.executeBatch ?? (async (): Promise<ToolBatchExecutionResult> => ({
    aborted: false,
    outcomes: [{
      index: 0,
      toolCall: { id: 't', name: 'ls', arguments: '{}' },
      args: {},
      resultText: 'ok',
      failed: false
    }]
  }))

  return runAgentLoop({
    messageId: 'msg_test',
    userText: 'hi',
    context,
    config: {
      maxToolRounds,
      toolExecution: 'parallel',
      maxParallelToolCalls: 4,
      supportsVision: false,
      ...(opts.assistantCompletionPolicy
        ? { assistantCompletionPolicy: opts.assistantCompletionPolicy }
        : {})
    },
    streamProcessor: processor,
    hookManager: new HookManager(),
    emit: (event: AgentEvent) => {},
    emitContextBreakdown: () => {},
    signal,
    abortSignal: () => undefined,
    executeBatch,
    onToolResultCommitted: opts.onToolResultCommitted,
    prepareMainRequest: async () => ({ status: 'within', revision: 0 }),
    observeMainRequest: () => {},
    updateTokenEstimate: () => {},
    sleep: () => Promise.resolve(),
    onTerminalError: () => {}
  })
}

describe('runAgentLoop 停止原因', () => {
  it('循环条件耗尽（while 判定 false）→ stopReason = max_rounds', async () => {
    const client = new MockModelClient()
    client.addResponse(toolCallResponse('t1'))
    client.addResponse(toolCallResponse('t2'))

    const endResult = await runKernel(client, 2)

    expect(endResult.ended).toBe('normal')
    expect(endResult.stopReason).toBe('max_rounds')
  })

  it('maxToolRounds=0（模型从未被调用）→ 不误报 max_rounds', async () => {
    const client = new MockModelClient()

    const endResult = await runKernel(client, 0)

    expect(endResult.ended).toBe('normal')
    expect(endResult.stopReason).toBeUndefined()
  })

  it('模型无工具调用自然收工 → 不设 stopReason', async () => {
    const client = new MockModelClient()
    client.addResponse(textResponse())

    const endResult = await runKernel(client, 10)

    expect(endResult.ended).toBe('normal')
    expect(endResult.stopReason).toBeUndefined()
  })

  it('turn_complete 在工具结果写回后正常结束，不标 cancelled 或 incomplete', async () => {
    const client = new MockModelClient()
    client.addResponse(toolCallResponse('t1'))
    let committed = 0

    const endResult = await runKernel(client, 1, {
      onToolResultCommitted: () => { committed++ },
      executeBatch: async () => ({
        aborted: false,
        outcomes: [{
          index: 0,
          toolCall: { id: 't1', name: 'stage_transition', arguments: '{}' },
          args: {},
          resultText: '用户选择忽略当前计划',
          control: { type: 'turn_complete' },
          failed: false
        }]
      })
    })

    expect(committed).toBe(1)
    expect(endResult).toEqual({ ended: 'normal' })
  })

  it('批次后 signal 置位 → cancelled，且不设 stopReason', async () => {
    const client = new MockModelClient()
    client.addResponse(toolCallResponse('t1'))
    let signalled = false

    const endResult = await runKernel(client, 10, {
      signal: () => signalled,
      executeBatch: async () => {
        signalled = true
        return {
          aborted: false,
          outcomes: [{
            index: 0,
            toolCall: { id: 't', name: 'ls', arguments: '{}' },
            args: {},
            resultText: 'ok',
            failed: false
          }]
        }
      }
    })

    expect(endResult.ended).toBe('normal')
    expect(endResult.cancelled).toBe(true)
    expect(endResult.stopReason).toBeUndefined()
  })

  it('仅思考无正文时续做一次，仍不设 stopReason', async () => {
    const client = new MockModelClient()
    client.addResponse(reasoningOnlyResponse())
    client.addResponse(textResponse())

    const endResult = await runKernel(client, 10, {
      assistantCompletionPolicy: createAssistantCompletionPolicy()
    })

    expect(endResult.ended).toBe('normal')
    expect(endResult.stopReason).toBeUndefined()
    expect(client.getCalls()).toHaveLength(2)
  })

  it('已有正文或已发工具时不续做', async () => {
    const client = new MockModelClient()
    client.addResponse(textResponse())
    const endText = await runKernel(client, 10, {
      assistantCompletionPolicy: createAssistantCompletionPolicy()
    })
    expect(endText.stopReason).toBeUndefined()
    expect(client.getCalls()).toHaveLength(1)

    const toolsClient = new MockModelClient()
    toolsClient.addResponse(toolCallResponse('t1'))
    toolsClient.addResponse(textResponse())
    const endTools = await runKernel(toolsClient, 10, {
      assistantCompletionPolicy: createAssistantCompletionPolicy()
    })
    expect(endTools.stopReason).toBeUndefined()
    expect(toolsClient.getCalls()).toHaveLength(2)
  })
})
