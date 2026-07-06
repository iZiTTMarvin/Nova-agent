/**
 * P1-B4 关键回归：连续两条不同 user 消息时 system prompt 前缀逐字节稳定；
 * L2 自动注入已停用，检索改由 memory_search 工具承担。
 */
import { describe, it, expect } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { buildStableSystemPrompt } from '../../../../src/runtime/agent/promptBuilder/modePrompt'
import { renderBaseRules } from '../../../../src/runtime/agent/promptRenderer'
import { extractTextFromContent } from '../../../../src/runtime/model/types'
import { L2_BLOCK_TITLE } from '../../../../src/runtime/memory/MemoryTailInjector'

const L1_ESSENCE = '用户偏好：注释一律使用中文。'

function createMemoryLoop(client: MockModelClient): AgentLoop {
  return new AgentLoop(client, new EventBus(), {
    systemPromptLayers: {
      agentRole: buildStableSystemPrompt({ workingDir: '/tmp/project' }),
      baseRules: renderBaseRules(),
      projectRules: '',
      memoryContext: L1_ESSENCE,
      skillContext: '',
      toolSummary: ''
    }
  })
}

describe('prefix-cache-stability（P1-B4）', () => {
  it('连续两条不同 user 消息 system prompt 逐字节一致，且无 L2 尾部块', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const loop = createMemoryLoop(client)

    await loop.sendMessage('帮我查认证模块')
    await loop.sendMessage('帮我看支付流程')

    const apiCalls = client.getCalls()
    expect(apiCalls).toHaveLength(2)

    const systemA = extractTextFromContent(
      apiCalls[0].messages.find((m) => m.role === 'system')?.content ?? ''
    )
    const systemB = extractTextFromContent(
      apiCalls[1].messages.find((m) => m.role === 'system')?.content ?? ''
    )

    expect(systemB).toBe(systemA)
    expect(systemA).toContain('Project Memory')
    expect(systemA).toContain(L1_ESSENCE)
    expect(systemA).not.toContain(L2_BLOCK_TITLE)

    for (const call of apiCalls) {
      const texts = call.messages.map((m) => extractTextFromContent(m.content))
      expect(texts.some((t) => t.includes(L2_BLOCK_TITLE))).toBe(false)
    }
  })

  it('L2 不进 AgentLoop 持久化 context.messages', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const loop = createMemoryLoop(client)
    await loop.sendMessage('写个函数')

    const persisted = loop.getContext()
    const texts = persisted.map((m) => extractTextFromContent(m.content))
    expect(texts.some((t) => t.includes(L2_BLOCK_TITLE))).toBe(false)
  })
})
