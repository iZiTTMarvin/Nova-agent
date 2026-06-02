import { describe, it, expect } from 'vitest'
import {
  shouldCompact,
  splitForCompaction,
  buildCompactionPrompt,
  rebuildWithCompression,
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
      const [old, recent] = splitForCompaction(messages, 10)
      expect(recent).toHaveLength(10)
      expect(old.length).toBeGreaterThan(0)
    })

    it('消息数不足 recentCount 时 old 为空', () => {
      const messages = makeMessages(5)
      const [old, recent] = splitForCompaction(messages, 10)
      expect(old).toHaveLength(0)
      expect(recent).toHaveLength(5)
    })

    it('system 消息不出现在 old 或 recent 中', () => {
      const messages = makeMessages(30)
      const [old, recent] = splitForCompaction(messages, 10)
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
      const [old, recent] = splitForCompaction(messages, 5)

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
      const [old, recent] = splitForCompaction(messages, 3)

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
    it('重建后第一条是 system prompt', () => {
      const result = rebuildWithCompression('system', 'summary', [])
      expect(result[0]).toEqual({ role: 'system', content: 'system' })
    })

    it('重建后第二条是摘要', () => {
      const result = rebuildWithCompression('system', '这是摘要', [])
      expect(result[1].role).toBe('user')
      expect(result[1].content).toContain('这是摘要')
    })

    it('重建后最近消息追加在尾部', () => {
      const recent: ChatMessage[] = [
        { role: 'user', content: '最近问题' },
        { role: 'assistant', content: '最近回复' }
      ]
      const result = rebuildWithCompression('system', 'summary', recent)
      expect(result).toHaveLength(4) // system + summary + 2 recent
      expect(result[2]).toEqual(recent[0])
      expect(result[3]).toEqual(recent[1])
    })
  })
})
