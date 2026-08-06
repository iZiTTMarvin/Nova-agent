import { describe, expect, it, vi } from 'vitest'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import type { ChatEvent, ChatMessage } from '../../../../src/runtime/model/types'
import { extractTextFromContent } from '../../../../src/runtime/model/types'
import { defaultContextBudgetManager } from '../../../../src/runtime/agent/ContextBudgetManager'
import { CompactionService } from '../../../../src/runtime/agent/compaction/CompactionService'
import { MAX_SUMMARY_ESTIMATED_TOKENS } from '../../../../src/runtime/agent/compaction/compaction'
import { CHARS_PER_TOKEN } from '../../../../src/runtime/agent/tokenEstimator'
import {
  createAgentContext,
  type AgentContext
} from '../../../../src/runtime/agent/core/AgentContext'
import type { CompactionMeta } from '../../../../src/runtime/agent/types'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'

function createMessages(count = 30, contentLength = 80): ChatMessage[] {
  return [
    { role: 'system', content: 'system prompt' },
    ...Array.from({ length: count }, (_, index): ChatMessage => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index}-${'x'.repeat(contentLength)}`
    }))
  ]
}

function createContext(messages: ChatMessage[]): AgentContext {
  return createAgentContext({
    readState: createReadState(),
    messages,
    systemPrompt: 'system prompt'
  })
}

function createService(options: {
  context: AgentContext
  client: MockModelClient
  onCompaction?: (context: ChatMessage[], meta: CompactionMeta) => void
}): {
  service: CompactionService
  context: AgentContext
  client: MockModelClient
  cacheDiagnostics: CacheDiagnostics
} {
  const cacheDiagnostics = new CacheDiagnostics()
  const service = new CompactionService({
    context: options.context,
    modelClient: options.client,
    contextBudgetManager: defaultContextBudgetManager,
    cacheDiagnostics,
    contextWindow: 100,
    onCompaction: options.onCompaction,
    getIdleCacheProfile: () => ({ idlePolicy: 'anthropic-short-ttl' })
  })
  return { service, context: options.context, client: options.client, cacheDiagnostics }
}

function summaryResponse(text: string): { events: ChatEvent[] } {
  return {
    events: [
      { type: 'text_delta', delta: text },
      { type: 'message_end', finishReason: 'stop' }
    ]
  }
}

describe('压缩摘要质量协议', () => {
  it('摘要 + 保留区不小于压缩前总量时拒绝采纳（fail-open）', async () => {
    const original = createMessages()
    const context = createContext(original)
    context.compactionLevel = 1
    context.userTurnsSinceCompaction = 4
    const onCompaction = vi.fn()
    // 被折叠的 oldMessages 约 900 字符（≈225 估算 token），摘要明显更大
    const client = new MockModelClient().addResponse(summaryResponse('冗长摘要\n' + 's'.repeat(2000)))
    const { service, cacheDiagnostics } = createService({ context, client, onCompaction })

    await expect(service.runThresholdCompaction()).resolves.toBe(false)

    expect(context.messages).toBe(original)
    expect(context.compactionLevel).toBe(1)
    expect(context.userTurnsSinceCompaction).toBe(4)
    expect(cacheDiagnostics.getEpochReason()).toBe('session_init')
    expect(onCompaction).not.toHaveBeenCalled()
  })

  it('overflow 路径同样 fail-open：拒绝时不改写上下文', async () => {
    const original = createMessages(32)
    const context = createContext(original)
    const onCompaction = vi.fn()
    const client = new MockModelClient().addResponse(summaryResponse('o'.repeat(2000)))
    const { service } = createService({ context, client, onCompaction })

    await expect(service.runOverflowCompaction('standard')).resolves.toBe(false)

    expect(context.messages).toBe(original)
    expect(context.compactionLevel).toBe(0)
    expect(onCompaction).not.toHaveBeenCalled()
  })

  it('摘要足够小时正常采纳并通知', async () => {
    const original = createMessages()
    const context = createContext(original)
    const onCompaction = vi.fn()
    const client = new MockModelClient().addResponse(summaryResponse('简短摘要'))
    const { service } = createService({ context, client, onCompaction })

    await expect(service.runThresholdCompaction()).resolves.toBe(true)

    expect(extractTextFromContent(context.messages[0].content)).toContain('简短摘要')
    expect(context.messages.slice(1)).toEqual(original.slice(-20))
    expect(context.compactionLevel).toBe(1)
    expect(context.userTurnsSinceCompaction).toBe(0)
    expect(onCompaction).toHaveBeenCalledWith(context.messages, {
      summary: '简短摘要',
      compactionLevel: 1,
      trigger: 'threshold'
    })
  })

  it('超过估算上限的摘要截断后正常采纳', async () => {
    // 长消息让 oldMessages 明显大于 768 估算 token，截断后的摘要仍有压缩收益
    const context = createContext(createMessages(30, 500))
    const onCompaction = vi.fn()
    const hugeSummary = 'h'.repeat(MAX_SUMMARY_ESTIMATED_TOKENS * CHARS_PER_TOKEN + 2000)
    const client = new MockModelClient().addResponse(summaryResponse(hugeSummary))
    const { service } = createService({ context, client, onCompaction })

    await expect(service.runThresholdCompaction()).resolves.toBe(true)

    const boundedLength = MAX_SUMMARY_ESTIMATED_TOKENS * CHARS_PER_TOKEN + '\n…[摘要已截断]'.length
    const meta = onCompaction.mock.calls[0][1] as CompactionMeta
    expect(meta.summary.endsWith('…[摘要已截断]')).toBe(true)
    expect(meta.summary.length).toBeLessThanOrEqual(boundedLength)
    expect(meta.summary.length).toBeLessThan(hugeSummary.length)
    expect(extractTextFromContent(context.messages[0].content)).toContain('…[摘要已截断]')
  })

  it('二次压缩时把前序摘要显式注入压缩输入并要求增量更新', async () => {
    const context = createContext(createMessages())
    const client = new MockModelClient()
      .addResponse(summaryResponse('第一版摘要'))
      .addResponse(summaryResponse('第二版摘要'))
    const { service } = createService({ context, client })

    await expect(service.runThresholdCompaction()).resolves.toBe(true)

    // 首次压缩的指令不含前序摘要段
    const firstCall = client.getCalls()[0]
    const firstInstruction = firstCall.messages[firstCall.messages.length - 1]
    expect(extractTextFromContent(firstInstruction.content)).not.toContain('前序摘要')

    // 压缩后再积累足够多的消息，触发第二次压缩
    context.messages.push(...Array.from({ length: 30 }, (_, index): ChatMessage => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `round2-${index}-${'y'.repeat(80)}`
    })))

    await expect(service.runThresholdCompaction()).resolves.toBe(true)

    const secondCall = client.getCalls()[1]
    const secondInstruction = secondCall.messages[secondCall.messages.length - 1]
    const instructionText = extractTextFromContent(secondInstruction.content)
    expect(instructionText).toContain('前序摘要')
    expect(instructionText).toContain('第一版摘要')
    expect(instructionText).toContain('不要推翻重写')
    expect(extractTextFromContent(context.messages[0].content)).toContain('第二版摘要')
  })
})
