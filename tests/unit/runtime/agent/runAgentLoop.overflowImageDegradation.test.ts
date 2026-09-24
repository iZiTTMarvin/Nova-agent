/**
 * runAgentLoop 溢出图片降级策略直测（Owner 侧）。
 *
 * 溢出恢复第一档只降级「最近一批之外」的历史工具图片，且每 turn 最多一次有效降级：
 * - 恢复历史时按最后一条 assistant toolCalls 关联识别受保护批次，同批多图全部保留；
 * - 关联不可靠或没有更早候选时不降级，回落标准压缩；
 * - 降级后模型重读同图的新结果不被旧集合误伤（复合键含 toolCallId），集合非空不再扩充。
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
import { IMAGE_OVERFLOW_OMITTED_PLACEHOLDER, type ActiveToolResultPrunePolicy, type SummaryProjection } from '../../../../src/runtime/request-projection'
import type { ChatEvent, ChatMessage, ChatToolCall, ContentBlock } from '../../../../src/runtime/model/types'
import type { ToolBatchExecutionResult } from '../../../../src/runtime/agent/execution/toolBatchExecutor'

const IMAGE_URL = 'data:image/png;base64,cG5nLWJ5dGVz'
const IMAGE_URL_B = 'data:image/png;base64,b3RoZXItcG5n'

function imageBlock(url: string): ContentBlock {
  return { type: 'image_url', image_url: { url } }
}

function overflowResponse(): { events: ChatEvent[] } {
  return { events: [{ type: 'context_overflow', rawError: 'context overflow token limit' }] }
}

function toolCallResponse(toolCallId: string): { events: ChatEvent[] } {
  return {
    events: [
      { type: 'message_start' },
      { type: 'tool_call_start', toolCallId, toolName: 'read', index: 0 },
      { type: 'tool_call', toolCall: { id: toolCallId, name: 'read', arguments: '{}' } },
      { type: 'message_end', finishReason: 'tool_calls' }
    ]
  }
}

function textResponse(text = '完成'): { events: ChatEvent[] } {
  return {
    events: [
      { type: 'message_start' },
      { type: 'text_delta', delta: text },
      { type: 'message_end', finishReason: 'stop' }
    ]
  }
}

function assistantWithCalls(...ids: string[]): ChatMessage {
  return { role: 'assistant', content: '', toolCalls: ids.map(id => ({ id, name: 'read', arguments: '{}' })) }
}

function imageToolMessage(toolCallId: string, url = IMAGE_URL): ChatMessage {
  return { role: 'tool', toolCallId, content: [imageBlock(url)] }
}

function imageOutcome(toolCallId: string, url = IMAGE_URL): ToolBatchExecutionResult {
  return {
    aborted: false,
    outcomes: [{
      index: 0,
      toolCall: { id: toolCallId, name: 'read', arguments: '{}' },
      args: {},
      resultText: '截图',
      resultImages: [{ data: url.slice(url.indexOf(',') + 1), mimeType: 'image/png' }],
      failed: false
    }]
  }
}

function toolContent(messages: ChatMessage[], toolCallId: string): ChatMessage['content'] | undefined {
  return messages.find(message => message.role === 'tool' && message.toolCallId === toolCallId)?.content
}

function createHarness(opts: {
  history: ChatMessage[]
  compactionResult?: () => Promise<boolean>
  runOverflowCompaction?: (mode: 'standard' | 'aggressive', projection: SummaryProjection) => Promise<boolean>
  executeBatch?: (toolCalls: ChatToolCall[]) => Promise<ToolBatchExecutionResult>
  resolveRequestProjectionPolicy?: () => ActiveToolResultPrunePolicy
}) {
  const client = new MockModelClient()
  const modelPool = new ModelClientPool({
    primary: client,
    primaryConfig: { baseUrl: 'http://test', apiKey: 'test', modelId: 'test-model' }
  })
  let compactionCalls = 0
  const processor = new StreamProcessor({
    modelPool,
    recovery: new RecoveryStateMachine(),
    cacheDiagnostics: new CacheDiagnostics(),
    emit: () => {},
    emitContextBreakdown: () => {},
    runOverflowCompaction: (mode, projection) => {
      compactionCalls++
      if (opts.runOverflowCompaction) return opts.runOverflowCompaction(mode, projection)
      return opts.compactionResult?.() ?? Promise.resolve(true)
    },
    hookManager: new HookManager()
  })
  const context = createAgentContext({
    dialect: 'native',
    mode: 'default',
    readState: createReadState(),
    messages: structuredClone(opts.history)
  })
  const run = () => runAgentLoop({
    messageId: 'msg_test',
    userText: '看图',
    context,
    config: {
      maxToolRounds: 8,
      toolExecution: 'parallel',
      maxParallelToolCalls: 4,
      supportsVision: true,
      ...(opts.resolveRequestProjectionPolicy
        ? { resolveRequestProjectionPolicy: opts.resolveRequestProjectionPolicy }
        : {})
    },
    streamProcessor: processor,
    hookManager: new HookManager(),
    emit: () => {},
    emitContextBreakdown: () => {},
    signal: () => false,
    abortSignal: () => undefined,
    executeBatch: opts.executeBatch ?? (async () => ({ aborted: false, outcomes: [] })),
    prepareMainRequest: async () => ({ status: 'within', revision: 0 }),
    observeMainRequest: () => {},
    updateTokenEstimate: () => {},
    sleep: () => Promise.resolve(),
    onTerminalError: () => {}
  })
  return { client, context, run, compactionCalls: () => compactionCalls }
}

describe('runAgentLoop 溢出图片降级策略', () => {
  it('恢复历史时保护最后一批：同批多图不降级，仅降级更早批次图片', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '看图' },
      assistantWithCalls('a1'),
      imageToolMessage('a1'),
      assistantWithCalls('b1', 'b2'),
      imageToolMessage('b1', IMAGE_URL_B),
      imageToolMessage('b2', IMAGE_URL_B)
    ]
    const { client, context, run, compactionCalls } = createHarness({ history })
    client.addResponse(overflowResponse())
    client.addResponse(textResponse())

    const end = await run()

    expect(end).toEqual({ ended: 'normal' })
    expect(compactionCalls()).toBe(0)
    expect(client.getCalls()).toHaveLength(2)
    const retried = client.getCalls()[1]!.messages
    expect(toolContent(retried, 'a1')).toEqual([{ type: 'text', text: IMAGE_OVERFLOW_OMITTED_PLACEHOLDER }])
    expect(toolContent(retried, 'b1')).toEqual([imageBlock(IMAGE_URL_B)])
    expect(toolContent(retried, 'b2')).toEqual([imageBlock(IMAGE_URL_B)])
    // 降级只发生在投影层，权威上下文保留原图
    expect(toolContent(context.messages, 'a1')).toEqual([imageBlock(IMAGE_URL)])
  })

  it('降级后模型重读同图：新结果不被旧集合误伤，且集合非空不再扩充', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '看图' },
      assistantWithCalls('a1'),
      imageToolMessage('a1'),
      assistantWithCalls('b1'),
      { role: 'tool', toolCallId: 'b1', content: '最新一批：无图结果' }
    ]
    const { client, run, compactionCalls } = createHarness({
      history,
      executeBatch: async () => imageOutcome('r2')
    })
    client.addResponse(overflowResponse())
    client.addResponse(toolCallResponse('r2'))
    client.addResponse(overflowResponse())
    client.addResponse(textResponse())

    const end = await run()

    expect(end).toEqual({ ended: 'normal' })
    expect(client.getCalls()).toHaveLength(4)
    // 第二次溢出时集合已非空：不再扩充，回落标准压缩
    expect(compactionCalls()).toBe(1)
    const finalCall = client.getCalls()[3]!.messages
    expect(toolContent(finalCall, 'a1')).toEqual([{ type: 'text', text: IMAGE_OVERFLOW_OMITTED_PLACEHOLDER }])
    // 同 URL 的新工具结果（不同 toolCallId）保持完整
    expect(toolContent(finalCall, 'r2')).toEqual([{ type: 'text', text: '截图' }, imageBlock(IMAGE_URL)])
  })

  it.each([
    ['最后一条 assistant 与现存 tool 消息对不上', [
      { role: 'user', content: '看图' },
      assistantWithCalls('ghost'),
      imageToolMessage('orphan')
    ]],
    ['没有 assistant toolCalls 可关联', [
      { role: 'user', content: '看图' },
      imageToolMessage('orphan')
    ]]
  ] as const)('关联不可靠（%s）→ 不降级，回落标准压缩', async (_name, history) => {
    const { client, run, compactionCalls } = createHarness({ history: history as ChatMessage[] })
    client.addResponse(overflowResponse())
    client.addResponse(textResponse())

    const end = await run()

    expect(end).toEqual({ ended: 'normal' })
    expect(compactionCalls()).toBe(1)
    const retried = client.getCalls()[1]!.messages
    expect(toolContent(retried, 'orphan')).toEqual([imageBlock(IMAGE_URL)])
  })

  it('最近一批全是图片：无更早候选时不降级', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '看图' },
      assistantWithCalls('c1'),
      imageToolMessage('c1')
    ]
    const { client, run, compactionCalls } = createHarness({ history })
    client.addResponse(overflowResponse())
    client.addResponse(textResponse())

    const end = await run()

    expect(end).toEqual({ ended: 'normal' })
    expect(compactionCalls()).toBe(1)
    expect(toolContent(client.getCalls()[1]!.messages, 'c1')).toEqual([imageBlock(IMAGE_URL)])
  })

  it('当前轮批次结果受保护：本批图片不降级，更早批次仍可降级', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '看图' },
      assistantWithCalls('a1'),
      imageToolMessage('a1'),
      assistantWithCalls('b1'),
      { role: 'tool', toolCallId: 'b1', content: '上一批文本结果' }
    ]
    const { client, run, compactionCalls } = createHarness({
      history,
      executeBatch: async () => imageOutcome('r1')
    })
    client.addResponse(toolCallResponse('r1'))
    client.addResponse(overflowResponse())
    client.addResponse(textResponse())

    const end = await run()

    expect(end).toEqual({ ended: 'normal' })
    expect(compactionCalls()).toBe(0)
    const retried = client.getCalls()[2]!.messages
    expect(toolContent(retried, 'a1')).toEqual([{ type: 'text', text: IMAGE_OVERFLOW_OMITTED_PLACEHOLDER }])
    expect(toolContent(retried, 'r1')).toEqual([{ type: 'text', text: '截图' }, imageBlock(IMAGE_URL)])
  })

  it('摘要投影与主请求投影对同一降级集合保持一致（字节恒等）', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '看图' },
      assistantWithCalls('a1'),
      imageToolMessage('a1'),
      assistantWithCalls('b1'),
      { role: 'tool', toolCallId: 'b1', content: '上一批文本结果' }
    ]
    let summaryMessages: ChatMessage[] | undefined
    const { client, context, run, compactionCalls } = createHarness({
      history,
      runOverflowCompaction: async (_mode, projection) => {
        summaryMessages = await projection.project(context.messages)
        return true
      }
    })
    client.addResponse(overflowResponse())
    client.addResponse(overflowResponse())
    client.addResponse(textResponse())

    const end = await run()

    expect(end).toEqual({ ended: 'normal' })
    expect(compactionCalls()).toBe(1)
    expect(summaryMessages).toBeDefined()
    // 压缩链与随后的主请求读取同一降级集合：两视图逐字节一致
    expect(JSON.stringify(summaryMessages)).toBe(JSON.stringify(client.getCalls()[2]!.messages))
  })

  it('投影归档策略在每次模型请求前重新解析（纾解层可在一个 turn 中途生效）', async () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'hi' }]
    let resolveCalls = 0
    const { client, run } = createHarness({
      history,
      resolveRequestProjectionPolicy: () => {
        resolveCalls++
        return { enabled: false }
      }
    })
    client.addResponse(toolCallResponse('r1'))
    client.addResponse(textResponse())

    const end = await run()

    expect(end).toEqual({ ended: 'normal' })
    expect(client.getCalls()).toHaveLength(2)
    expect(resolveCalls).toBe(2)
  })
})
