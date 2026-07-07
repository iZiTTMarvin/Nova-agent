/**
 * contextBuilder 图片 URL 转换单测（P0 修复回归）
 *
 * 验证：历史消息里的 nova-image:// URL 经 resolveImageUrl 回调转回 base64 data URL，
 * 确保多轮对话中模型能看到历史图片（模型 API 不认识自定义协议）。
 * 同时验证：未注入回调时原样透传（向后兼容单测路径）。
 */
import { describe, it, expect } from 'vitest'
import { buildConversationContext, resolveImageUrlsInMessages } from '../../../../src/runtime/agent/context/contextBuilder'
import type { SessionData, SessionMessage } from '../../../../src/runtime/sessions/types'
import type { ChatMessage } from '../../../../src/runtime/model/types'

const NOVA_URL = 'nova-image://sess_test/abc123.png'
const BASE64_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGawjM9AQAAAABJRU5ErkJggg=='

function buildSession(messages: SessionMessage[]): SessionData {
  return {
    schemaVersion: 6,
    id: 'sess_test',
    workspaceRoot: '/tmp',
    mode: 'default',
    messages,
    currentLeafId: messages.at(-1)?.id ?? null,
    createdAt: 1,
    updatedAt: 1,
    title: 'test',
    titleSource: 'placeholder',
    messageCount: messages.length
  }
}

describe('contextBuilder 图片 URL 转换', () => {
  describe('buildConversationContext 带 resolveImageUrl', () => {
    it('历史 user 消息的 image_url 被回调转换', () => {
      const userMsg: SessionMessage = {
        id: 'msg_1',
        role: 'user',
        parentId: null,
        timestamp: 1,
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image_url', image_url: { url: NOVA_URL } }
        ]
      }
      const session = buildSession([userMsg])

      const ctx = buildConversationContext(session, 'default', (url) =>
        url === NOVA_URL ? BASE64_URL : url
      )

      const content = ctx[0].content as Array<{ type: string; image_url?: { url: string } }>
      const imageBlock = content.find(b => b.type === 'image_url')
      expect(imageBlock?.image_url?.url).toBe(BASE64_URL)
    })

    it('纯文本 user 消息不受影响', () => {
      const userMsg: SessionMessage = {
        id: 'msg_1',
        role: 'user',
        parentId: null,
        timestamp: 1,
        content: '纯文本消息'
      }
      const session = buildSession([userMsg])

      const ctx = buildConversationContext(session, 'default', () => BASE64_URL)
      expect(ctx[0].content).toBe('纯文本消息')
    })

    it('未注入回调时 image_url 原样透传（向后兼容）', () => {
      const userMsg: SessionMessage = {
        id: 'msg_1',
        role: 'user',
        parentId: null,
        timestamp: 1,
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: NOVA_URL } }
        ]
      }
      const session = buildSession([userMsg])

      const ctx = buildConversationContext(session, 'default')
      const content = ctx[0].content as Array<{ type: string; image_url?: { url: string } }>
      const imageBlock = content.find(b => b.type === 'image_url')
      expect(imageBlock?.image_url?.url).toBe(NOVA_URL)
    })

    it('已是 base64 的 image_url 不被转换（只转 nova-image://）', () => {
      const userMsg: SessionMessage = {
        id: 'msg_1',
        role: 'user',
        parentId: null,
        timestamp: 1,
        content: [
          { type: 'image_url', image_url: { url: BASE64_URL } }
        ]
      }
      const session = buildSession([userMsg])

      let called = false
      const ctx = buildConversationContext(session, 'default', (url) => {
        called = true
        return url
      })
      const content = ctx[0].content as Array<{ type: string; image_url?: { url: string } }>
      expect(content[0].image_url?.url).toBe(BASE64_URL)
      expect(called).toBe(false) // 回调不应被调用
    })
  })

  describe('resolveImageUrlsInMessages（快照 recentMessages 路径）', () => {
    it('转换消息数组中的 nova-image:// URL', () => {
      const messages: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: '历史图' },
            { type: 'image_url', image_url: { url: NOVA_URL } }
          ]
        },
        {
          role: 'assistant',
          content: '回复'
        }
      ]

      const resolved = resolveImageUrlsInMessages(messages, (url) =>
        url === NOVA_URL ? BASE64_URL : url
      )
      const content = resolved[0].content as Array<{ type: string; image_url?: { url: string } }>
      expect(content[1].image_url?.url).toBe(BASE64_URL)
      // 纯文本消息不变
      expect(resolved[1].content).toBe('回复')
    })

    it('无图片消息时返回原数组引用（无变更零开销）', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: '文本' },
        { role: 'assistant', content: '回复' }
      ]
      const resolved = resolveImageUrlsInMessages(messages, () => BASE64_URL)
      expect(resolved).toBe(messages) // 同一引用
    })
  })
})
