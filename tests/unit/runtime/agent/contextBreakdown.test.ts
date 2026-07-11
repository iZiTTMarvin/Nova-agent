import { describe, it, expect, vi } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ToolContext, ToolResult } from '../../../../src/runtime/tools/types'
import type { AgentEvent } from '../../../../src/runtime/agent/types'
import { calculateContextBreakdown } from '../../../../src/runtime/agent/context/contextBreakdownCalculator'
import { buildConversationContext } from '../../../../src/runtime/agent/context/contextBuilder'
import {
  estimateChatMessageTokens,
  estimateTokens,
  estimateContextTokens
} from '../../../../src/runtime/agent/tokenEstimator'
import { extractTextFromSerializableContent } from '../../../../src/runtime/sessions/types'
import type { SessionData } from '../../../../src/runtime/sessions/types'
import { getSessionActiveMessages } from '../../../../src/runtime/sessions/tree'

/** 创建一个包含 ls 工具的测试 Registry */
function createTestRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: 'ls',
    description: '列出目录',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径' }
      }
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { success: true, output: `目录内容: ${args.path ?? '.'}` }
    }
  })
  return registry
}

function createLoopWithSkillContext(skillContext: string): {
  loop: AgentLoop
  eventBus: EventBus
  client: MockModelClient
  events: AgentEvent[]
} {
  const client = new MockModelClient()
  const eventBus = new EventBus()
  const loop = new AgentLoop(client, eventBus, {
    systemPromptLayers: {
      agentRole: '你是助手。',
      skillContext
    },
    skillsTokenEstimate: Math.ceil(skillContext.length / 4)
  })
  loop.setToolRegistry(createTestRegistry())
  loop.setSessionContext({ async save() {} } as any, 'sess_test')

  const events: AgentEvent[] = []
  eventBus.on((e) => events.push(e as AgentEvent))

  return { loop, eventBus, client, events }
}

describe('AgentLoop context_breakdown', () => {
  it('usage 事件后 emit context_breakdown，五项之和等于 totalEstimated', async () => {
    const { loop, client, events } = createLoopWithSkillContext('这是技能上下文')

    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复内容' },
        {
          type: 'usage',
          usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 0, cacheWriteTokens: 0 }
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    await loop.sendMessage('hello')

    const breakdownEvents = events.filter((e) => e.type === 'context_breakdown')
    expect(breakdownEvents).toHaveLength(1)

    const ev = breakdownEvents[0] as Extract<AgentEvent, { type: 'context_breakdown' }>
    const { breakdown, totalEstimated, promptTokensActual } = ev

    expect(promptTokensActual).toBe(100)
    expect(totalEstimated).toBe(
      breakdown.systemPrompt + breakdown.skills + breakdown.tools + breakdown.messages + breakdown.other
    )
    expect(breakdown.skills).toBeGreaterThan(0)
    // 回归：emitContextBreakdown 内部构造的 session 是 AgentLoop 自身线性 this.context 的快照，
    // 不应因 getSessionActiveMessages 的 currentLeafId 树形回溯语义而把已入 context 的
    // user 消息算丢（历史 bug：currentLeafId 恒为 null 导致 messages 桶恒为 0）。
    expect(breakdown.messages).toBeGreaterThan(0)
  })

  it('无 usage 事件时兜底 emit context_breakdown', async () => {
    const { loop, client, events } = createLoopWithSkillContext('')

    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复内容' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    await loop.sendMessage('hello')

    const breakdownEvents = events.filter((e) => e.type === 'context_breakdown')
    expect(breakdownEvents).toHaveLength(1)

    const ev = breakdownEvents[0] as Extract<AgentEvent, { type: 'context_breakdown' }>
    expect(ev.promptTokensActual).toBe(0)
    expect(ev.totalEstimated).toBeGreaterThan(0)
  })

  it('skills 不会与 systemPrompt 重复计算', async () => {
    const skillContext = '技能上下文正文若干字'
    const { loop, client, events } = createLoopWithSkillContext(skillContext)

    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'hi' },
        {
          type: 'usage',
          usage: { promptTokens: 50, completionTokens: 5, cachedTokens: 0, cacheWriteTokens: 0 }
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    await loop.sendMessage('hello')

    const ev = events.find((e) => e.type === 'context_breakdown') as Extract<
      AgentEvent,
      { type: 'context_breakdown' }
    >

    // 冻结 system prompt 包含 skillContext；统计时应把 skill 部分拆出去，
    // 因此 systemPrompt + skills 应约等于完整 system prompt 的 char/4 估算。
    expect(ev.breakdown.systemPrompt + ev.breakdown.skills).toBe(ev.totalEstimated - ev.breakdown.tools - ev.breakdown.messages - ev.breakdown.other)
    expect(ev.breakdown.skills).toBe(Math.ceil(skillContext.length / 4))
  })

  it('多 tool round 时每轮都 emit context_breakdown', async () => {
    const { loop, client, events } = createLoopWithSkillContext('')

    // round 1: model 调用工具
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'tool_call',
          toolCall: { id: 'tc-1', name: 'ls', arguments: '{"path":"."}' }
        },
        {
          type: 'usage',
          usage: { promptTokens: 80, completionTokens: 5, cachedTokens: 0, cacheWriteTokens: 0 }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })

    // round 2: model 最终文本回复，且没有 usage
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'done' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    await loop.sendMessage('list')

    const breakdownEvents = events.filter((e) => e.type === 'context_breakdown') as Array<
      Extract<AgentEvent, { type: 'context_breakdown' }>
    >
    expect(breakdownEvents).toHaveLength(2)
    // 回归：第二轮已把第一轮的 tool_call/tool_result 追加进 this.context，
    // messages 桶理应比第一轮更大——而不是像历史 bug 那样恒为 0 保持不变。
    expect(breakdownEvents[1]!.breakdown.messages).toBeGreaterThan(breakdownEvents[0]!.breakdown.messages)
  })
})

describe('calculateContextBreakdown（SessionData 口径）', () => {
  /** 模拟持久化形态：tool result 嵌在 assistant.toolCalls.result，无独立 role:tool 消息 */
  function sessionWithLargeToolResult(toolResultChars: number): SessionData {
    const toolResult = 'x'.repeat(toolResultChars)
    const userId = 'msg_user'
    const asstId = 'msg_asst'
    return {
      schemaVersion: 8,
      id: 'sess_breakdown_tool',
      workspaceRoot: '/ws',
      mode: 'default',
      currentLeafId: asstId,
      createdAt: 1,
      updatedAt: 1,
      frozenSystemPrompt: '你是助手。',
      messages: [
        {
          id: userId,
          parentId: null,
          role: 'user',
          content: '请读取大文件',
          timestamp: 1
        },
        {
          id: asstId,
          parentId: userId,
          role: 'assistant',
          content: '已读取',
          timestamp: 2,
          toolCalls: [
            {
              id: 'tc-read',
              name: 'read',
              arguments: '{"path":"big.ts"}',
              result: toolResult
            }
          ]
        }
      ]
    }
  }

  /** 旧口径：只投影 content 文本，漏计 tool result（回归对照） */
  function legacyMessagesTokensOnlyContent(session: SessionData): number {
    const historyMessages = getSessionActiveMessages(session)
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role,
        content: extractTextFromSerializableContent(m.content),
        toolCalls: m.toolCalls?.map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments
        }))
      }))
    return estimateContextTokens(historyMessages)
  }

  it('含大 tool result 的 SessionData：messages 桶与 buildConversationContext 同口径', () => {
    const session = sessionWithLargeToolResult(40_000)
    const { payload } = calculateContextBreakdown({
      session,
      skills: 0,
      toolDefinitions: [],
      contextLimit: 200_000
    })

    const expected = buildConversationContext(session, session.mode).reduce(
      (sum, m) => sum + estimateChatMessageTokens(m),
      0
    )
    expect(payload.breakdown.messages).toBe(expected)
    // 工具结果约 10K tokens，必须计入
    expect(payload.breakdown.messages).toBeGreaterThanOrEqual(estimateTokens('x'.repeat(40_000)))
  })

  it('不再严重低估：messages 桶远大于仅 content 文本投影的旧口径', () => {
    const session = sessionWithLargeToolResult(40_000)
    const { payload } = calculateContextBreakdown({
      session,
      skills: 0,
      toolDefinitions: [],
      contextLimit: 200_000
    })

    const legacy = legacyMessagesTokensOnlyContent(session)
    // 旧口径只剩 user+assistant 正文（数百 token 量级）；新口径含 40K 字符工具结果
    expect(legacy).toBeLessThan(1_000)
    expect(payload.breakdown.messages).toBeGreaterThan(legacy * 10)
  })
})
