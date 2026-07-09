/**
 * visionProjection — 发 API 前视觉能力投影
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../../src/runtime/model/types'
import {
  projectMessagesForVision,
  providerRejectsToolMultimodal
} from '../../../../src/runtime/model/visionProjection'

const IMG = {
  type: 'image_url' as const,
  image_url: { url: 'data:image/png;base64,abc' }
}

describe('providerRejectsToolMultimodal', () => {
  it('识别 mimo / xiaomimimo', () => {
    expect(providerRejectsToolMultimodal('mimo-v2.5', 'https://api.example.com/v1')).toBe(true)
    expect(providerRejectsToolMultimodal('other', 'https://api.xiaomimimo.com/v1')).toBe(true)
    expect(providerRejectsToolMultimodal('gpt-4o', 'https://api.openai.com/v1')).toBe(false)
  })
})

describe('projectMessagesForVision', () => {
  it('非视觉：剥离 user 历史 image_url，保留文本', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看这张图' },
          IMG
        ]
      },
      { role: 'user', content: '继续文字对话' }
    ]
    const out = projectMessagesForVision(messages, {
      supportsVision: false,
      modelId: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com/v1'
    })
    expect(typeof out[0].content).toBe('string')
    expect(String(out[0].content)).toContain('看看这张图')
    expect(String(out[0].content)).toContain('不支持图片')
    expect(out[1].content).toBe('继续文字对话')
  })

  it('非视觉：tool 多模态压成纯文本', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: 'c1',
        content: [
          { type: 'text', text: '已读取图片' },
          IMG
        ]
      }
    ]
    const out = projectMessagesForVision(messages, {
      supportsVision: false,
      modelId: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com/v1'
    })
    expect(out).toHaveLength(1)
    expect(typeof out[0].content).toBe('string')
    expect(String(out[0].content)).toContain('已读取图片')
  })

  it('视觉 + OpenAI 兼容：原样保留', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi' }, IMG]
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        content: [{ type: 'text', text: 'img' }, IMG]
      }
    ]
    const out = projectMessagesForVision(messages, {
      supportsVision: true,
      modelId: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1'
    })
    expect(out).toEqual(messages)
  })

  it('视觉 + MiMo：tool 图提升为后续 user，tool.content 为 string', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        content: [
          { type: 'text', text: '已读取图片文件' },
          IMG
        ]
      }
    ]
    const out = projectMessagesForVision(messages, {
      supportsVision: true,
      modelId: 'mimo-v2.5',
      baseUrl: 'https://api.xiaomimimo.com/v1'
    })
    expect(out).toHaveLength(3)
    expect(out[1].role).toBe('tool')
    expect(typeof out[1].content).toBe('string')
    expect(out[2].role).toBe('user')
    const blocks = out[2].content as Array<{ type: string }>
    expect(blocks.some(b => b.type === 'image_url')).toBe(true)
    expect(out[2].skipCacheMarker).toBe(true)
  })

  it('投影后无空 content', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [IMG] }
    ]
    const out = projectMessagesForVision(messages, {
      supportsVision: false,
      modelId: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com/v1'
    })
    expect(String(out[0].content).trim().length).toBeGreaterThan(0)
  })
})
