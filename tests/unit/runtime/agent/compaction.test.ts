import { describe, it, expect } from 'vitest'
import {
  shouldCompact,
  splitForCompaction,
  buildCompactionPrompt,
  rebuildWithCompression,
  rollbackBefore,
  COMPACTION_THRESHOLD,
  MIN_RECENT_MESSAGES
} from '../../../../src/runtime/agent/compaction'
import { estimateTokens, estimateContextTokens } from '../../../../src/runtime/agent/tokenEstimator'
import type { ChatMessage } from '../../../../src/runtime/model/types'

function makeMessages(count: number, contentLength = 100): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system prompt' }
  ]
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(contentLength)
    })
  }
  return messages
}

describe('tokenEstimator', () => {
  it('空字符串返回 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('粗略估算 token 数', () => {
    expect(estimateTokens('hello world')).toBe(3) // 11 chars / 4 = 2.75 → 3
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })

  it('estimateContextTokens 累加所有消息', () => {
    const messages = [
      { content: 'a'.repeat(100) },
      { content: 'b'.repeat(200) },
      { content: 'c'.repeat(300) }
    ]
    expect(estimateContextTokens(messages)).toBe(150) // (100+200+300)/4
  })
})

describe('compaction', () => {
  describe('shouldCompact', () => {
    it('消息数不足时不触发', () => {
      const messages = makeMessages(10)
      expect(shouldCompact(messages)).toBe(false)
    })

    it('token 数未达阈值时不触发', () => {
      const messages = makeMessages(30, 100)
      expect(shouldCompact(messages)).toBe(false)
    })

    it('token 数超过阈值时触发', () => {
      // 30 条消息 × 20000 字符 = 600000 字符 → 150000 tokens > 120000
      const messages = makeMessages(30, 20000)
      expect(shouldCompact(messages)).toBe(true)
    })

    it('自定义阈值生效', () => {
      const messages = makeMessages(30, 100)
      expect(shouldCompact(messages, 1)).toBe(true)
    })
  })

  describe('splitForCompaction', () => {
    it('保留最近 N 条消息', () => {
      const messages = makeMessages(30)
      const { oldMessages: old, recentMessages: recent } = splitForCompaction(messages, 10)
      expect(recent).toHaveLength(10)
      expect(old.length).toBeGreaterThan(0)
    })

    it('消息数不足 recentCount 时 old 为空', () => {
      const messages = makeMessages(5)
      const { oldMessages: old, recentMessages: recent } = splitForCompaction(messages, 10)
      expect(old).toHaveLength(0)
      expect(recent).toHaveLength(5)
    })

    it('system 消息不出现在 old 或 recent 中', () => {
      const messages = makeMessages(30)
      const { oldMessages: old, recentMessages: recent } = splitForCompaction(messages, 10)
      expect(old.every(m => m.role !== 'system')).toBe(true)
      expect(recent.every(m => m.role !== 'system')).toBe(true)
    })

    it('切点对齐工具调用组边界：不切碎 assistant(toolCalls) + tool 配对', () => {
      // 构造含工具调用组的上下文：
      // system, user, assistant(toolCalls), tool, tool, user, assistant, user, ...
      const messages: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'thinking', toolCalls: [
          { id: 'tc1', name: 'read', arguments: '{}' },
          { id: 'tc2', name: 'grep', arguments: '{}' }
        ]},
        { role: 'tool', content: 'file content', toolCallId: 'tc1' },
        { role: 'tool', content: 'grep result', toolCallId: 'tc2' },
        // 以上是一个完整的工具调用组
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'reply2' },
        { role: 'user', content: 'q3' },
        { role: 'assistant', content: 'reply3' },
        { role: 'user', content: 'q4' },
        { role: 'assistant', content: 'reply4' }
      ]

      // 保留最近 5 条，切点本应落在 tool 消息上
      const { oldMessages: old, recentMessages: recent } = splitForCompaction(messages, 5)

      // recent 不应以 tool 消息开头（孤儿 tool）
      expect(recent[0].role).not.toBe('tool')

      // 工具调用组应完整在同一侧
      // 如果 assistant(toolCalls) 在 recent 中，对应的 tool 消息也必须在 recent 中
      for (const msg of recent) {
        if (msg.role === 'assistant' && msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            const toolMsg = recent.find(m => m.role === 'tool' && m.toolCallId === tc.id)
            expect(toolMsg).toBeDefined()
          }
        }
      }
    })

    it('切点对齐：assistant(toolCalls) 在切点上时，整组移入 recent', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'thinking', toolCalls: [
          { id: 'tc1', name: 'ls', arguments: '{}' }
        ]},
        { role: 'tool', content: 'dir listing', toolCallId: 'tc1' },
        { role: 'user', content: 'q3' },
        { role: 'assistant', content: 'a3' }
      ]

      // 保留最近 3 条：预期 recent = [user:q3, assistant:a3] + 可能更多
      const { oldMessages: old, recentMessages: recent } = splitForCompaction(messages, 3)

      // recent 不应以 tool 开头
      expect(recent[0].role).not.toBe('tool')

      // old 中不应有孤立的 tool 消息（没有对应 assistant(toolCalls) 的 tool）
      const oldAssistantToolCallIds = new Set<string>()
      for (const msg of old) {
        if (msg.role === 'assistant' && msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            oldAssistantToolCallIds.add(tc.id)
          }
        }
      }
      for (const msg of old) {
        if (msg.role === 'tool' && msg.toolCallId) {
          expect(oldAssistantToolCallIds.has(msg.toolCallId)).toBe(true)
        }
      }
    })
  })

  describe('buildCompactionPrompt', () => {
    it('包含最近消息数', () => {
      const prompt = buildCompactionPrompt(20)
      expect(prompt).toContain('20')
    })

    it('包含摘要要求', () => {
      const prompt = buildCompactionPrompt(10)
      expect(prompt).toContain('摘要')
    })
  })

  describe('rebuildWithCompression', () => {
    it('重建后第一条是 system prompt（含摘要合并）', () => {
      const result = rebuildWithCompression('system', 'summary', [])
      expect(result).toHaveLength(1)
      expect(result[0].role).toBe('system')
      expect(result[0].content).toBe('system\n\n[对话历史摘要]\nsummary')
    })

    it('摘要合并到 system 消息尾部，保持前缀稳定', () => {
      const result = rebuildWithCompression('你是编程助手', '之前讨论了架构设计', [])
      // system prompt 前缀部分（"你是编程助手"）逐字节不变，能命中缓存
      expect(result[0].content).toContain('你是编程助手')
      expect(result[0].content).toContain('之前讨论了架构设计')
      // 不应有独立的 user 消息作为摘要
      expect(result).toHaveLength(1)
    })

    it('重建后最近消息追加在 system 之后', () => {
      const recent: ChatMessage[] = [
        { role: 'user', content: '最近问题' },
        { role: 'assistant', content: '最近回复' }
      ]
      const result = rebuildWithCompression('system', 'summary', recent)
      expect(result).toHaveLength(3) // system(+摘要) + 2 recent
      expect(result[1]).toEqual(recent[0])
      expect(result[2]).toEqual(recent[1])
    })

    it('重建时携带 pulledBackMessages', () => {
      const recent: ChatMessage[] = [{ role: 'user', content: 'recent' }]
      const pb: ChatMessage[] = [{ role: 'assistant', content: 'pulled' }]
      const result = rebuildWithCompression('system', 'summary', recent, pb)
      expect(result).toHaveLength(3) // system(+摘要) + 1 recent + 1 pulledBack
      expect(result[2]).toEqual(pb[0])
    })
  })

  describe('rollbackBefore', () => {
    it('回滚到指定索引之前', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' }
      ]
      const result = rollbackBefore(messages, 2)
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual(messages[0])
      expect(result[1]).toEqual(messages[1])
    })

    it('越界或负数索引返回原 context', () => {
      const messages = makeMessages(3)
      expect(rollbackBefore(messages, -1)).toEqual(messages)
      expect(rollbackBefore(messages, 10)).toEqual(messages)
    })
  })

  describe('splitForCompaction with pullBackFromTail', () => {
    it('从 recentMessages 末尾弹出指定数量的消息', () => {
      const messages = makeMessages(30)
      const { oldMessages, recentMessages, pulledBackMessages } = splitForCompaction(messages, 10, 3)
      expect(recentMessages).toHaveLength(7) // 10 - 3 = 7
      expect(pulledBackMessages).toHaveLength(3)
      expect(oldMessages.length).toBeGreaterThan(0)
    })

    it('弹出消息时不破坏工具调用组对齐（工具在尾部被弹走，assistant 也跟着弹走）', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'thinking', toolCalls: [
          { id: 'tc1', name: 'read', arguments: '{}' }
        ]},
        { role: 'tool', content: 'file content', toolCallId: 'tc1' },
        { role: 'user', content: 'q2' }
      ]

      // split 并弹出 1 条消息（user: q2）
      const result1 = splitForCompaction(messages, 4, 1)
      expect(result1.pulledBackMessages).toHaveLength(1)
      expect(result1.pulledBackMessages[0].role).toBe('user')

      // 如果弹出 2 条消息（原本是 tool 和 q2，会触发边界对齐将整个工具组弹走）
      const result2 = splitForCompaction(messages, 4, 2)
      // 弹出后，recentMessages 结尾不能是孤儿 toolCall
      // 本例中最近消息最多保留 4 条，包含 assistant + tool + q2，现在要从尾部弹 2 条
      // 分界线指向 tool。由于 alignPullBackBoundary，分界线会前移，把 assistant 和 tool 也一起弹走
      expect(result2.pulledBackMessages.some(m => m.role === 'assistant')).toBe(true)
      expect(result2.recentMessages.every(m => m.role !== 'tool' && !m.toolCalls)).toBe(true)
    })
  })
})
