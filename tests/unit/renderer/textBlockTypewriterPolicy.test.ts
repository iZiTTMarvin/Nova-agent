import { describe, it, expect } from 'vitest'
import {
  getLastTextBlockIndex,
  isTailActiveTextBlock,
  shouldEnableTextBlockTypewriter
} from '../../../src/renderer/features/chat/textBlockTypewriterPolicy'
import type { RendererMessageBlock } from '../../../src/renderer/stores/types'

function text(content: string): RendererMessageBlock {
  return { type: 'text', content }
}

function tool(id: string, name = 'read'): RendererMessageBlock {
  return {
    type: 'tool',
    toolCallId: id,
    toolName: name,
    arguments: {},
    status: 'running'
  }
}

describe('textBlockTypewriterPolicy', () => {
  describe('getLastTextBlockIndex', () => {
    it('空 blocks 返回 -1', () => {
      expect(getLastTextBlockIndex(undefined)).toBe(-1)
      expect(getLastTextBlockIndex([])).toBe(-1)
    })

    it('[text, tool] 返回 0', () => {
      expect(getLastTextBlockIndex([text('旁白'), tool('tc1')])).toBe(0)
    })

    it('[text, tool, text] 返回 2', () => {
      expect(getLastTextBlockIndex([text('前'), tool('tc1'), text('后')])).toBe(2)
    })
  })

  describe('isTailActiveTextBlock', () => {
    it('[text, tool] 尾部是 tool → false', () => {
      expect(isTailActiveTextBlock([text('旁白'), tool('tc1')])).toBe(false)
    })

    it('[text, tool, text] 尾部是 text → true', () => {
      expect(isTailActiveTextBlock([text('前'), tool('tc1'), text('后')])).toBe(true)
    })
  })

  describe('shouldEnableTextBlockTypewriter', () => {
    it('轮次未进行时不启用', () => {
      expect(shouldEnableTextBlockTypewriter({
        isTurnActive: false,
        blockIndex: 0,
        blocks: [text('唯一正文')]
      })).toBe(false)
    })

    it('[text, tool]：封口 text 块不启用（回归：工具间残片 bug）', () => {
      const blocks = [text('token 消费 SSE'), tool('tc1')]
      expect(shouldEnableTextBlockTypewriter({
        isTurnActive: true,
        blockIndex: 0,
        blocks
      })).toBe(false)
    })

    it('[text, tool, text]：前段 text 全文、尾 text 启用', () => {
      const blocks = [text('1) LlmService'), tool('tc1'), text('LlmService 完成')]
      expect(shouldEnableTextBlockTypewriter({
        isTurnActive: true,
        blockIndex: 0,
        blocks
      })).toBe(false)
      expect(shouldEnableTextBlockTypewriter({
        isTurnActive: true,
        blockIndex: 2,
        blocks
      })).toBe(true)
    })

    it('仅一个 text 块且轮次进行中时启用', () => {
      expect(shouldEnableTextBlockTypewriter({
        isTurnActive: true,
        blockIndex: 0,
        blocks: [text('流式输出中')]
      })).toBe(true)
    })

    it('[thinking, text, tool]：text 已封口不启用', () => {
      const blocks: RendererMessageBlock[] = [
        { type: 'thinking', content: '思考' },
        text('说明'),
        tool('tc1')
      ]
      expect(shouldEnableTextBlockTypewriter({
        isTurnActive: true,
        blockIndex: 1,
        blocks
      })).toBe(false)
    })
  })
})
