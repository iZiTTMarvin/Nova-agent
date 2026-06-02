import { describe, it, expect } from 'vitest'
import { applyCacheMarkers, applyToolCacheMarker } from '../../../../src/runtime/model/messageFormat'

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

    it('anthropic 策略对最后 2 条非 system 消息注入 cache_control', () => {
      const messages = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' }
      ]
      const result = applyCacheMarkers(messages, 'anthropic')

      // system 不变
      expect(result[0].content).toBe('system')

      // msg1 不标记（倒数第 3 条）
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

    it('空消息数组返回空数组', () => {
      expect(applyCacheMarkers([], 'anthropic')).toEqual([])
    })

    it('只有 system 消息时不标记', () => {
      const messages = [{ role: 'system', content: 'system' }]
      const result = applyCacheMarkers(messages, 'anthropic')
      expect(result[0].content).toBe('system')
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
})
