import { describe, it, expect } from 'vitest'
import { applyCacheMarkers, applyToolCacheMarker, sanitizeToolMessages } from '../../../../src/runtime/model/messageFormat'
import type { ChatMessage } from '../../../../src/runtime/model/types'

describe('messageFormat 缓存标记适配器', () => {
  describe('applyCacheMarkers', () => {
    it('auto 策略不注入任何标记', () => {
      const messages = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' }
      ]
      const result = applyCacheMarkers(messages, 'auto')
      expect(result).toEqual(messages)
    })

    it('anthropic 策略对 system 消息 + 最后 2 条非 system 消息注入 cache_control', () => {
      const messages = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' }
      ]
      const result = applyCacheMarkers(messages, 'anthropic')

      // system 消息也被标记缓存
      expect(Array.isArray(result[0].content)).toBe(true)
      const systemContent = result[0].content as Array<Record<string, unknown>>
      expect(systemContent[0].cache_control).toEqual({ type: 'ephemeral' })

      // msg1 不标记（倒数第 3 条非 system）
      expect(result[1].content).toBe('msg1')

      // msg2 标记（倒数第 2 条非 system）
      expect(Array.isArray(result[2].content)).toBe(true)
      const content2 = result[2].content as Array<Record<string, unknown>>
      expect(content2[0].cache_control).toEqual({ type: 'ephemeral' })

      // msg3 标记（最后一条）
      expect(Array.isArray(result[3].content)).toBe(true)
      const content3 = result[3].content as Array<Record<string, unknown>>
      expect(content3[0].cache_control).toEqual({ type: 'ephemeral' })
    })

    it('system 消息的缓存标记能让首轮写入后后续轮次命中 cache_read', () => {
      // 模拟：只有 system + 1 条 user，验证 system 也被标记
      const messages = [
        { role: 'system', content: '你是编程助手' },
        { role: 'user', content: 'hello' }
      ]
      const result = applyCacheMarkers(messages, 'anthropic')

      // system 被标记
      expect(Array.isArray(result[0].content)).toBe(true)
      const sysContent = result[0].content as Array<Record<string, unknown>>
      expect(sysContent[0].cache_control).toEqual({ type: 'ephemeral' })

      // user 也被标记
      expect(Array.isArray(result[1].content)).toBe(true)
      const userContent = result[1].content as Array<Record<string, unknown>>
      expect(userContent[0].cache_control).toEqual({ type: 'ephemeral' })
    })

    it('跳过 skipCacheMarker 消息，不标记缓存', () => {
      const messages = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'L2 memory block', skipCacheMarker: true }
      ]
      const result = applyCacheMarkers(messages, 'anthropic')

      // skipCacheMarker 消息（最后一条 user）不被标记
      expect(result[3].content).toBe('L2 memory block')

      // 倒数第 2 条非 system 非 skipCacheMarker 消息（assistant）被标记
      expect(Array.isArray(result[2].content)).toBe(true)
      const content2 = result[2].content as Array<Record<string, unknown>>
      expect(content2[0].cache_control).toEqual({ type: 'ephemeral' })
    })

    it('跳过 internal 消息，不标记缓存', () => {
      const messages = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'compression instruction', internal: true }
      ]
      const result = applyCacheMarkers(messages, 'anthropic')

      // internal 消息（最后一条 user）不被标记
      expect(result[3].content).toBe('compression instruction')

      // 倒数第 2 条非 system 非 internal 消息（assistant）被标记
      expect(Array.isArray(result[2].content)).toBe(true)
      const content2 = result[2].content as Array<Record<string, unknown>>
      expect(content2[0].cache_control).toEqual({ type: 'ephemeral' })
    })

    it('空消息数组返回空数组', () => {
      expect(applyCacheMarkers([], 'anthropic')).toEqual([])
    })

    it('只有 system 消息时也标记 system', () => {
      const messages = [{ role: 'system', content: 'system' }]
      const result = applyCacheMarkers(messages, 'anthropic')
      // system 消息被标记缓存
      expect(Array.isArray(result[0].content)).toBe(true)
      const sysContent = result[0].content as Array<Record<string, unknown>>
      expect(sysContent[0].cache_control).toEqual({ type: 'ephemeral' })
    })

    it('不修改原数组', () => {
      const messages = [
        { role: 'user', content: 'hello' }
      ]
      const result = applyCacheMarkers(messages, 'anthropic')
      expect(messages[0].content).toBe('hello')
      expect(result[0].content).not.toBe('hello')
    })
  })

  describe('applyToolCacheMarker', () => {
    it('auto 策略不注入', () => {
      const tools = [{ type: 'function', function: { name: 'ls' } }]
      const result = applyToolCacheMarker(tools, 'auto')
      expect(result[0]).not.toHaveProperty('cache_control')
    })

    it('anthropic 策略对最后一个工具注入 cache_control', () => {
      const tools = [
        { type: 'function', function: { name: 'ls' } },
        { type: 'function', function: { name: 'read' } },
        { type: 'function', function: { name: 'bash' } }
      ]
      const result = applyToolCacheMarker(tools, 'anthropic')
      expect(result[0]).not.toHaveProperty('cache_control')
      expect(result[1]).not.toHaveProperty('cache_control')
      expect(result[2].cache_control).toEqual({ type: 'ephemeral' })
    })

    it('空工具数组返回空数组', () => {
      expect(applyToolCacheMarker([], 'anthropic')).toEqual([])
    })
  })

  describe('sanitizeToolMessages 工具调用配对规整', () => {
    it('丢弃孤立 tool 消息（前面没有声明它的 assistant.tool_calls）', () => {
      // 复现 DeepSeek 400：role:'tool' 没有前置配对 → 必须被丢弃
      const messages: ChatMessage[] = [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: '孤立结果', toolCallId: 'orphan_1' },
        { role: 'assistant', content: '回答' }
      ]
      const result = sanitizeToolMessages(messages)
      expect(result).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '回答' }
      ])
    })

    it('保留完整配对的 assistant.tool_calls + tool 响应', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'ls', arguments: '{}' }] },
        { role: 'tool', content: 'files', toolCallId: 'c1' },
        { role: 'assistant', content: 'done' }
      ]
      const result = sanitizeToolMessages(messages)
      expect(result).toEqual(messages)
    })

    it('剥离部分缺响应的 tool_calls，保留有响应的项', () => {
      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'c1', name: 'ls', arguments: '{}' },
            { id: 'c2', name: 'read', arguments: '{}' }
          ]
        },
        { role: 'tool', content: 'files', toolCallId: 'c1' }
        // c2 无响应
      ]
      const result = sanitizeToolMessages(messages)
      expect(result).toEqual([
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'ls', arguments: '{}' }] },
        { role: 'tool', content: 'files', toolCallId: 'c1' }
      ])
    })

    it('assistant 全部 tool_calls 缺响应且正文为空时整条丢弃（典型：批次被取消）', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'ls', arguments: '{}' }] }
      ]
      const result = sanitizeToolMessages(messages)
      expect(result).toEqual([{ role: 'user', content: 'q' }])
    })

    it('assistant 全部 tool_calls 缺响应但有正文时退化为普通文本消息', () => {
      const messages: ChatMessage[] = [
        { role: 'assistant', content: '我打算调用工具', toolCalls: [{ id: 'c1', name: 'ls', arguments: '{}' }] }
      ]
      const result = sanitizeToolMessages(messages)
      expect(result).toEqual([{ role: 'assistant', content: '我打算调用工具' }])
    })

    it('tool 消息出现在声明它的 assistant 之前时视为孤立丢弃（顺序敏感）', () => {
      const messages: ChatMessage[] = [
        { role: 'tool', content: 'early', toolCallId: 'c1' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'ls', arguments: '{}' }] }
      ]
      const result = sanitizeToolMessages(messages)
      // 前置 tool 被丢弃；assistant 的 c1 因此变成缺响应、正文为空 → 整条丢弃
      expect(result).toEqual([])
    })

    it('不修改原数组', () => {
      const messages: ChatMessage[] = [
        { role: 'tool', content: 'orphan', toolCallId: 'x' }
      ]
      const result = sanitizeToolMessages(messages)
      expect(messages.length).toBe(1)
      expect(result.length).toBe(0)
    })
  })
})
