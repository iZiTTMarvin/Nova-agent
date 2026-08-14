import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetChatStoreForTests,
  useChatStore
} from '../../../../../src/renderer/stores/useChatStore'
import { projectLiveMessage } from '../../../../../src/renderer/features/chat/useEffectiveMessage'
import type { ExtendedMessage } from '../../../../../src/renderer/stores/types'

const mockInvoke = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStoreForTests()
  global.window = {
    ...global.window,
    api: {
      invoke: mockInvoke,
      on: vi.fn(() => () => {}),
      removeAllListeners: vi.fn()
    }
  } as unknown as Window & typeof globalThis
})

describe('liveTurn 活跃回合', () => {
  it('纯 text delta：messages 引用严格稳定，活跃回合累积', () => {
    useChatStore.getState().handleMessageStart('m1')
    const ref = useChatStore.getState().messages

    useChatStore.getState().applyStreamDeltas([{ kind: 'text', messageId: 'm1', delta: 'ab' }])
    useChatStore.getState().applyStreamDeltas([{ kind: 'text', messageId: 'm1', delta: 'cd' }])

    expect(useChatStore.getState().messages).toBe(ref)
    expect(useChatStore.getState().messages[0].content).toBe('')
    expect(useChatStore.getState().liveTurn['m1']).toEqual({ type: 'text', content: 'abcd' })
  })

  it('订阅计数：N 次纯 text batch 只产生 N 次通知，messages 不变', () => {
    useChatStore.getState().handleMessageStart('m1')
    const sub = vi.fn()
    const unsub = useChatStore.subscribe(sub)

    useChatStore.getState().applyStreamDeltas([{ kind: 'text', messageId: 'm1', delta: 'a' }])
    useChatStore.getState().applyStreamDeltas([{ kind: 'text', messageId: 'm1', delta: 'b' }])
    useChatStore.getState().applyStreamDeltas([{ kind: 'text', messageId: 'm1', delta: 'c' }])

    expect(sub).toHaveBeenCalledTimes(3)
    unsub()
  })

  it('fold at handleToolCallStart：活跃文本封存为终态块，位于 tool 块之前', () => {
    useChatStore.getState().handleMessageStart('m1')
    useChatStore.getState().applyStreamDeltas([{ kind: 'text', messageId: 'm1', delta: '前置说明' }])
    useChatStore.getState().handleToolCallStart('m1', 'tc1', 'read')

    const msg = useChatStore.getState().messages[0]
    expect(msg.blocks?.map(b => b.type)).toEqual(['text', 'tool'])
    expect(msg.blocks?.[0]).toMatchObject({ type: 'text', content: '前置说明' })
    expect(msg.content).toBe('前置说明')
    expect(useChatStore.getState().liveTurn['m1']).toBeUndefined()
  })

  it('fold at handleMessageEnd：终态 content 与直写等价，活跃回合清空', async () => {
    mockInvoke.mockResolvedValue(undefined)
    // 基线：直接把整段文本 fold 进 messages（用 toolCallStart 触发 fold）
    useChatStore.getState().handleMessageStart('direct')
    useChatStore.getState().applyStreamDeltas([
      { kind: 'thinking', messageId: 'direct', delta: '想' },
      { kind: 'text', messageId: 'direct', delta: '你好' },
      { kind: 'text', messageId: 'direct', delta: '，Nova' }
    ])
    await useChatStore.getState().handleMessageEnd('direct')
    const direct = useChatStore.getState().messages[0]
    expect(direct.content).toBe('你好，Nova')
    expect(direct.thinking).toBe('想')
    expect(direct.blocks?.map(b => b.type)).toEqual(['thinking', 'text'])
    expect(useChatStore.getState().liveTurn['direct']).toBeUndefined()
  })

  it('fold at handleError：保留已产出内容并附加错误', async () => {
    mockInvoke.mockResolvedValue(undefined)
    useChatStore.getState().handleMessageStart('m_err')
    useChatStore.getState().applyStreamDeltas([{ kind: 'text', messageId: 'm_err', delta: '部分回答' }])

    await useChatStore.getState().handleError('m_err', '出错了')

    const msg = useChatStore.getState().messages[0]
    expect(msg.content).toBe('部分回答')
    expect(msg.isError).toBe(true)
    expect(msg.blocks?.some(b => b.type === 'text')).toBe(true)
    expect(useChatStore.getState().liveTurn['m_err']).toBeUndefined()
  })

  it('handleAttemptFailed：丢弃活跃回合内容并清空消息壳', () => {
    useChatStore.getState().handleMessageStart('m_att')
    useChatStore.getState().applyStreamDeltas([{ kind: 'text', messageId: 'm_att', delta: '失败尝试内容' }])

    useChatStore.getState().handleAttemptFailed('m_att', 'att_1')

    const msg = useChatStore.getState().messages[0]
    expect(msg.content).toBe('')
    expect(msg.blocks).toEqual([])
    expect(useChatStore.getState().liveTurn['m_att']).toBeUndefined()
  })

  it('handleAttemptFailed：保留已完成工具，只丢掉末尾临时思考', () => {
    useChatStore.getState().handleMessageStart('m_keep')
    useChatStore.getState().handleToolCallStart('m_keep', 'tc1', 'ls')
    useChatStore.getState().handleToolCall('m_keep', 'tc1', 'ls', { path: '.' })
    useChatStore.getState().handleToolResult('m_keep', 'tc1', 'ls', 'ok')
    useChatStore.getState().applyStreamDeltas([
      { kind: 'thinking', messageId: 'm_keep', delta: '失败 attempt 的思考' }
    ])

    useChatStore.getState().handleAttemptFailed('m_keep', 'att_2')

    const msg = useChatStore.getState().messages[0]
    expect(msg.blocks?.map(b => b.type)).toEqual(['tool'])
    expect(msg.blocks?.[0]).toMatchObject({ type: 'tool', toolCallId: 'tc1', status: 'success' })
    expect(msg.toolCalls?.some(tc => tc.id === 'tc1')).toBe(true)
    expect(useChatStore.getState().liveTurn['m_keep']).toBeUndefined()
  })

  it('连续 text 与 thinking 跨 batch 切换：thinking 封存、text 进活跃', () => {
    useChatStore.getState().handleMessageStart('m1')
    useChatStore.getState().applyStreamDeltas([{ kind: 'thinking', messageId: 'm1', delta: '思考' }])
    useChatStore.getState().applyStreamDeltas([{ kind: 'text', messageId: 'm1', delta: '正文' }])

    const msg = useChatStore.getState().messages[0]
    expect(msg.thinking).toBe('思考')
    expect(msg.blocks).toEqual([
      { type: 'thinking', content: '思考', durationMs: expect.any(Number) }
    ])
    expect(useChatStore.getState().liveTurn['m1']).toEqual({ type: 'text', content: '正文' })
  })

  it('同 batch 内 text→toolCall：text 被工具 delta 封存进 messages', () => {
    useChatStore.getState().handleMessageStart('m1')
    useChatStore.getState().handleToolCallStart('m1', 'tc1', 'write')
    // tool 块已占位；之后同 batch 内再来 text + toolCall partial
    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'm1', delta: '旁白' },
      { kind: 'toolCall', messageId: 'm1', toolCallId: 'tc1', delta: '{"path":"a.ts"}' }
    ])

    const msg = useChatStore.getState().messages[0]
    // text 被随后的 toolCall 封存，挂到 tool 之后
    expect(msg.blocks?.map(b => b.type)).toEqual(['tool', 'text'])
    expect(msg.content).toBe('旁白')
    expect(useChatStore.getState().liveTurn['m1']).toBeUndefined()
  })

  it('projectLiveMessage：末块同类型则合并为单块（与 fold 一致，避免流式/折叠跳变）', () => {
    const base: ExtendedMessage = {
      id: 'm1', sessionId: 's', role: 'assistant', content: '已封存', timestamp: 0, _revision: 3,
      blocks: [{ type: 'text', content: '已封存' }]
    }
    const projected = projectLiveMessage(base, { type: 'text', content: '流式' })
    expect(projected.content).toBe('已封存流式')
    expect(projected.blocks).toEqual([{ type: 'text', content: '已封存流式' }])
    // 不 bump（重渲染由 hook 驱动）；不污染原对象
    expect(projected._revision).toBe(3)
    expect(base.blocks).toHaveLength(1)
    expect(base.content).toBe('已封存')
  })

  it('projectLiveMessage：末块不同类型则 push 新块', () => {
    const base: ExtendedMessage = {
      id: 'm1', sessionId: 's', role: 'assistant', content: '', timestamp: 0, _revision: 0,
      blocks: [{ type: 'tool', toolCallId: 't', toolName: 'read', arguments: {}, status: 'success' }]
    }
    const projected = projectLiveMessage(base, { type: 'text', content: '流式' })
    expect(projected.blocks?.map(b => b.type)).toEqual(['tool', 'text'])
  })

  it('特征：[text, toolCall, text] 单 batch 后 fold 仍为单文本块（与 OLD 等价，不割裂 markdown）', () => {
    useChatStore.getState().handleMessageStart('m1')
    useChatStore.getState().handleToolCallStart('m1', 'tc1', 'read')
    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'm1', delta: '你好' },
      { kind: 'toolCall', messageId: 'm1', toolCallId: 'tc1', delta: '{"path":"a"}' },
      { kind: 'text', messageId: 'm1', delta: '再见' }
    ])
    // toolCall partial delta 不割裂文本：封存的 text + 后续 live text 折叠为单块
    useChatStore.getState().handleToolCallStart('m1', 'tc2', 'read')
    const msg = useChatStore.getState().messages[0]
    const textBlocks = msg.blocks?.filter(b => b.type === 'text')
    expect(textBlocks).toHaveLength(1)
    expect(textBlocks?.[0]).toMatchObject({ content: '你好再见' })
    expect(msg.content).toBe('你好再见')
  })

  it('projectLiveMessage：thinking 活跃块叠加到 thinking 字段', () => {
    const base: ExtendedMessage = {
      id: 'm1', sessionId: 's', role: 'assistant', content: '', timestamp: 0, _revision: 0
    }
    const projected = projectLiveMessage(base, { type: 'thinking', content: '推理中' })
    expect(projected.thinking).toBe('推理中')
    expect(projected.content).toBe('')
    expect(projected.blocks).toEqual([{ type: 'thinking', content: '推理中' }])
  })
})
