import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetChatStoreForTests,
  useChatStore
} from '../../../../../src/renderer/stores/useChatStore'
import {
  readThinkingElapsedSec,
  resetThinkingTimingMemory
} from '../../../../../src/renderer/lib/thinkingTimingMemory'

describe('streamSlice', () => {
  beforeEach(() => {
    resetChatStoreForTests()
    resetThinkingTimingMemory()
  })

  it('applyStreamDeltas 一次调用只产生一次 Store 订阅通知', () => {
    useChatStore.getState().handleMessageStart('msg_batch')
    const subscriber = vi.fn()
    const unsubscribe = useChatStore.subscribe(subscriber)

    useChatStore.getState().applyStreamDeltas([
      { kind: 'thinking', messageId: 'msg_batch', delta: '先分析' },
      { kind: 'thinking', messageId: 'msg_batch', delta: '上下文' },
      { kind: 'text', messageId: 'msg_batch', delta: '结论' },
      { kind: 'text', messageId: 'msg_batch', delta: '完成' }
    ])

    expect(subscriber).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('thinking→text 封存时写入思考耗时，可供 ThinkingBlock remount 后读取', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    useChatStore.getState().handleMessageStart('msg_timing')

    useChatStore.getState().applyStreamDeltas([
      { kind: 'thinking', messageId: 'msg_timing', delta: '先分析' }
    ])
    vi.setSystemTime(new Date('2026-01-01T00:00:01.700Z'))
    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_timing', delta: '结论' }
    ])

    expect(readThinkingElapsedSec('msg_timing', 0)).toBeCloseTo(1.7, 5)
    const thinking = useChatStore.getState().messages[0]?.blocks?.find(b => b.type === 'thinking')
    expect(thinking).toMatchObject({ type: 'thinking', durationMs: 1700 })
    vi.useRealTimers()
  })

  it('纯 text/thinking delta 只写活跃回合：messages 引用稳定，liveTurn 累积', () => {
    useChatStore.getState().handleMessageStart('msg_text')
    useChatStore.getState().handleMessageStart('msg_thinking')
    const messagesRefBefore = useChatStore.getState().messages

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_text', delta: 'a' },
      { kind: 'thinking', messageId: 'msg_thinking', delta: 'x' }
    ])
    // messages 完全没动 —— 顶层不再因流式文本每帧重提交
    expect(useChatStore.getState().messages).toBe(messagesRefBefore)
    expect(useChatStore.getState().liveTurn['msg_text']).toMatchObject({ type: 'text', content: 'a' })
    expect(useChatStore.getState().liveTurn['msg_thinking']).toMatchObject({ type: 'thinking', content: 'x' })
    const liveTextRef = useChatStore.getState().liveTurn['msg_text']

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_text', delta: 'b' },
      { kind: 'thinking', messageId: 'msg_thinking', delta: 'y' }
    ])
    expect(useChatStore.getState().messages).toBe(messagesRefBefore)
    expect(useChatStore.getState().liveTurn['msg_text']).toMatchObject({ type: 'text', content: 'ab' })
    expect(useChatStore.getState().liveTurn['msg_thinking']).toMatchObject({ type: 'thinking', content: 'xy' })
    // 活跃块每批是新引用，订阅才能感知并驱动活跃 MessageItem 重渲染
    expect(useChatStore.getState().liveTurn['msg_text']).not.toBe(liveTextRef)
  })

  it('迟到 partial delta 不覆盖已 finalize 的完整 arguments', () => {    useChatStore.getState().handleMessageStart('msg_tool')
    useChatStore.getState().handleToolCallStart('msg_tool', 'tool_1', 'write')
    useChatStore.getState().applyStreamDeltas([
      {
        kind: 'toolCall',
        messageId: 'msg_tool',
        toolCallId: 'tool_1',
        delta: '{"content":"partial'
      }
    ])
    useChatStore.getState().handleToolCall('msg_tool', 'tool_1', 'write', {
      path: 'index.html',
      content: 'complete'
    })

    useChatStore.getState().applyStreamDeltas([
      {
        kind: 'toolCall',
        messageId: 'msg_tool',
        toolCallId: 'tool_1',
        delta: '-late"}'
      }
    ])

    const message = useChatStore.getState().messages[0]
    const toolBlock = message.blocks?.find(
      block => block.type === 'tool' && block.toolCallId === 'tool_1'
    )
    const toolCall = message.toolCalls?.find(call => call.id === 'tool_1')
    expect(toolBlock).toMatchObject({
      arguments: { path: 'index.html', content: 'complete' }
    })
    expect(toolCall?.arguments).toEqual({
      path: 'index.html',
      content: 'complete'
    })
  })

  it('嵌套工具事件（run_code 沙箱内）不创建顶级工具块，只记入父块活动', () => {
    useChatStore.getState().handleMessageStart('msg_code')
    useChatStore.getState().handleToolCall('msg_code', 'tc_run_code', 'run_code', {
      code: 'return 1',
      description: '探索'
    })
    useChatStore.getState().handleToolCall(
      'msg_code',
      'tc_run_code#nested-1',
      'read',
      { path: 'a.ts' },
      'tc_run_code'
    )
    useChatStore.getState().handleToolCall(
      'msg_code',
      'tc_run_code#nested-2',
      'grep',
      { pattern: 'todo' },
      'tc_run_code'
    )
    useChatStore.getState().handleToolResult(
      'msg_code',
      'tc_run_code#nested-1',
      'read',
      '文件内容',
      'tc_run_code',
      false
    )
    useChatStore.getState().handleToolResult(
      'msg_code',
      'tc_run_code#nested-2',
      'grep',
      '工具 "grep" 不可用：所属工具组未激活',
      'tc_run_code',
      true
    )

    const message = useChatStore.getState().messages[0]
    const toolBlocks = (message.blocks ?? []).filter(b => b.type === 'tool')
    // 只有父 run_code 块；嵌套调用不是顶级块
    expect(toolBlocks).toHaveLength(1)

    const parent = toolBlocks[0]
    expect(parent).toMatchObject({ type: 'tool', toolCallId: 'tc_run_code', toolName: 'run_code' })
    expect(parent.nestedActivities).toEqual([
      { toolCallId: 'tc_run_code#nested-1', toolName: 'read', args: { path: 'a.ts' }, status: 'success' },
      { toolCallId: 'tc_run_code#nested-2', toolName: 'grep', args: { pattern: 'todo' }, status: 'error' }
    ])
    // toolCalls 登记簿同样只含父调用
    expect(message.toolCalls?.map(tc => tc.id)).toEqual(['tc_run_code'])
  })

  it('取消会终结父工具下仍在运行的嵌套活动', async () => {
    useChatStore.getState().handleMessageStart('msg_cancel_code')
    useChatStore.getState().handleToolCall('msg_cancel_code', 'tc_run_code', 'run_code', {
      code: 'await tools.read({ path: "slow.ts" })',
      description: '探索'
    })
    useChatStore.getState().handleToolCall(
      'msg_cancel_code',
      'tc_run_code#nested-1',
      'read',
      { path: 'slow.ts' },
      'tc_run_code'
    )

    await useChatStore.getState().markRunningAsCancelled()
    const parent = useChatStore.getState().messages[0]?.blocks?.find(
      block => block.type === 'tool' && block.toolCallId === 'tc_run_code'
    )
    expect(parent).toMatchObject({
      status: 'error',
      nestedActivities: [{ toolCallId: 'tc_run_code#nested-1', status: 'error' }]
    })
  })
})
