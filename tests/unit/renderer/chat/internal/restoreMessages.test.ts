import { describe, expect, it } from 'vitest'
import type { Message } from '../../../../../src/shared/session/types'
import {
  getToolCallStatus,
  restoreSessionMessages,
  stripInlinePseudoToolCalls,
  stripLegacyThinkingTags
} from '../../../../../src/renderer/stores/chat/internal'
import type { RendererMessageBlock } from '../../../../../src/renderer/stores/chat/types'

describe('getToolCallStatus', () => {
  it('无 result 视为成功', () => {
    expect(getToolCallStatus(undefined)).toBe('success')
  })

  it('普通输出视为成功', () => {
    expect(getToolCallStatus('done')).toBe('success')
  })

  it('runtime 失败文案与权限拒绝文案视为失败', () => {
    expect(getToolCallStatus('工具执行失败: boom')).toBe('error')
    expect(getToolCallStatus('权限拒绝: 用户否决')).toBe('error')
  })
})

describe('stripLegacyThinkingTags', () => {
  it('剥离闭合的 <think> 标签', () => {
    expect(stripLegacyThinkingTags('<think>推理内容</think>正文')).toBe('正文')
  })

  it('剥离未闭合的 <think> 尾块', () => {
    expect(stripLegacyThinkingTags('正文<think>未闭合的推理')).toBe('正文')
  })

  it('无标签的正文原样返回', () => {
    expect(stripLegacyThinkingTags('纯正文')).toBe('纯正文')
  })
})

describe('stripInlinePseudoToolCalls', () => {
  it('无伪调用时原引用透传', () => {
    const blocks: RendererMessageBlock[] = [{ type: 'text', content: '正常正文' }]
    const result = stripInlinePseudoToolCalls('正常正文', blocks)

    expect(result.content).toBe('正常正文')
    expect(result.blocks).toBe(blocks)
  })

  it('剥离正文里的行内 JSON 伪调用并同步清理末尾 text block', () => {
    const pseudo = '我看一下目录 {"name":"list_directory","arguments":{"path":"."}}'
    const blocks: RendererMessageBlock[] = [{ type: 'text', content: pseudo }]
    const result = stripInlinePseudoToolCalls(pseudo, blocks)

    expect(result.content).not.toContain('list_directory')
    expect(result.content).toContain('我看一下目录')
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]).toMatchObject({ type: 'text' })
    expect((result.blocks[0] as { content: string }).content).not.toContain('list_directory')
  })

  it('伪调用剥离后 text block 变空时移除该 block', () => {
    const pseudo = '{"name":"list_directory","arguments":{"path":"."}}'
    const blocks: RendererMessageBlock[] = [{ type: 'text', content: pseudo }]
    const result = stripInlinePseudoToolCalls(pseudo, blocks)

    expect(result.content).toBe('')
    expect(result.blocks).toHaveLength(0)
  })
})

describe('restoreSessionMessages', () => {
  it('无 blocks 的旧消息：剥离 <think>、从 content 与 toolCalls 构造 blocks', () => {
    const messages: Message[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        content: '<think>内心戏</think>回答文本',
        toolCalls: [{ id: 'tc1', name: 'read', arguments: { path: 'a.ts' } }],
        ...( { _toolCallResults: { tc1: '文件内容' } } as object )
      } as Message
    ]

    const [restored] = restoreSessionMessages(messages)

    expect(restored.content).toBe('回答文本')
    expect(restored._revision).toBe(0)
    expect(restored.toolCalls).toEqual([
      {
        id: 'tc1',
        name: 'read',
        arguments: { path: 'a.ts' },
        status: 'success',
        result: '文件内容'
      }
    ])
    expect(restored.blocks).toEqual([
      { type: 'text', content: '回答文本' },
      {
        type: 'tool',
        toolCallId: 'tc1',
        toolName: 'read',
        arguments: { path: 'a.ts' },
        status: 'success',
        result: '文件内容'
      }
    ])
  })

  it('失败 result 恢复为 error 状态', () => {
    const messages: Message[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'bash', arguments: { command: 'x' } }],
        ...( { _toolCallResults: { tc1: '工具执行失败: exit 1' } } as object )
      } as Message
    ]

    const [restored] = restoreSessionMessages(messages)

    expect(restored.toolCalls?.[0].status).toBe('error')
    expect(restored.blocks).toEqual([
      expect.objectContaining({ type: 'tool', status: 'error', result: '工具执行失败: exit 1' })
    ])
  })

  it('已有 blocks 的消息：保留 thinking / 图片块，tool block 原样透传小参数', () => {
    const messages: Message[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        content: '看图',
        blocks: [
          { type: 'thinking', content: '推理' },
          { type: 'text', content: '看图' },
          {
            type: 'image',
            fileName: 'a.png',
            dataUrl: 'data:image/png;base64,xx',
            mimeType: 'image/png'
          },
          {
            type: 'tool',
            toolCallId: 'tc1',
            toolName: 'read',
            arguments: { path: 'a.ts' },
            status: 'success',
            result: '内容'
          }
        ]
      } as Message
    ]

    const [restored] = restoreSessionMessages(messages)

    expect(restored._revision).toBe(0)
    expect(restored.blocks).toEqual([
      { type: 'thinking', content: '推理' },
      { type: 'text', content: '看图' },
      expect.objectContaining({ type: 'image', fileName: 'a.png' }),
      expect.objectContaining({
        type: 'tool',
        toolCallId: 'tc1',
        arguments: { path: 'a.ts' },
        result: '内容'
      })
    ])
  })

  it('content 为空且无 toolCalls 时构造出空 blocks', () => {
    const messages: Message[] = [
      { id: 'm1', sessionId: 's1', role: 'user', content: '' } as Message
    ]

    const [restored] = restoreSessionMessages(messages)

    expect(restored.blocks).toEqual([])
    expect(restored.toolCalls).toBeUndefined()
  })
})
