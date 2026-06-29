import { describe, expect, it } from 'vitest'
import {
  TAIL_LIVE_MESSAGE_COUNT,
  resolveMessageRenderMode
} from '../../../src/renderer/features/chat/messageRenderTier'

describe('messageRenderTier', () => {
  it('TAIL_LIVE_MESSAGE_COUNT 应为 6', () => {
    expect(TAIL_LIVE_MESSAGE_COUNT).toBe(6)
  })

  it('消息数不超过尾部窗口时应全部为 live', () => {
    for (let i = 0; i < 6; i++) {
      expect(resolveMessageRenderMode(i, 6, false)).toBe('live')
      expect(resolveMessageRenderMode(i, 6, true)).toBe('live')
    }
  })

  it('超过尾部窗口时，前部消息应为 static', () => {
    const total = 20
    const cutoff = total - TAIL_LIVE_MESSAGE_COUNT
    for (let i = 0; i < cutoff; i++) {
      expect(resolveMessageRenderMode(i, total, true)).toBe('static')
      expect(resolveMessageRenderMode(i, total, false)).toBe('static')
    }
    for (let i = cutoff; i < total; i++) {
      expect(resolveMessageRenderMode(i, total, true)).toBe('live')
    }
  })

  it('空列表返回 live', () => {
    expect(resolveMessageRenderMode(0, 0, false)).toBe('live')
  })
})
