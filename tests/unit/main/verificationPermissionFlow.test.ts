import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventBus } from '../../../src/runtime/agent/EventBus'
import {
  accumulateStreamEvent,
  markActiveStreamsCancelled,
  activeStreams,
  type MessageContext
} from '../../../src/main/agent/events'

/**
 * agentHandler 真实入口测试
 *
 * 直接 import 并调用 agentHandler 内部导出的函数：
 * - accumulateStreamEvent：流式事件累积
 *
 * 通过 vi.mock 替代 SessionStore/checkpoint 等外部依赖，
 * 测试的是 agentHandler 自己的代码，不是手写的模拟闭包。
 */

// mock sessionHandler 的 getSessionStore，避免真实磁盘 IO
// 生产热路径已切到 appendMessageFast，mock 必须对齐真实接口（禁止生产加慢路径 fallback）
const mockAppendMessage = vi.fn()
const mockAppendMessageFast = vi.fn(() => ({
  ok: true as const,
  status: 'appended' as const,
  meta: { id: 'sess_1', messageCount: 1 }
}))
const mockAppendMessagePatch = vi.fn()
const mockStore = {
  appendMessage: mockAppendMessage,
  appendMessageFast: mockAppendMessageFast,
  appendMessagePatch: mockAppendMessagePatch,
  save: vi.fn(),
  load: vi.fn(),
  getSessionsDir: () => '/tmp/test-sessions'
}
vi.mock('../../../src/main/services/SessionStoreHost', () => ({
  getSessionStore: () => mockStore
}))

vi.mock('../../../src/main/index', () => ({
  setCurrentProjectPath: vi.fn(),
  setCurrentMode: vi.fn()
}))

import { getSessionStore } from '../../../src/main/services/SessionStoreHost'

function makeCtx(overrides?: Partial<MessageContext>): MessageContext {
  return {
    mode: 'default',
    permissionPolicy: 'ask',
    workspaceRoot: '/tmp/project',
    sessionsDir: '/tmp/test-sessions',
    eventBus: new EventBus(),
    getMainWindow: () => null,
    ...overrides
  }
}

describe('agentHandler 真实入口测试', () => {
  beforeEach(() => {
    activeStreams.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('accumulateStreamEvent — 真实函数', () => {
    it('message_start 创建累积器，text_delta 累积文本，message_end 保存消息', () => {
      const ctx = makeCtx()

      accumulateStreamEvent('sess_1', { type: 'message_start', messageId: 'msg_1' }, ctx)
      expect(activeStreams.has('msg_1')).toBe(true)

      accumulateStreamEvent('sess_1', { type: 'text_delta', messageId: 'msg_1', delta: '你好，' }, ctx)
      accumulateStreamEvent('sess_1', { type: 'text_delta', messageId: 'msg_1', delta: '世界。' }, ctx)

      const stream = activeStreams.get('msg_1')!
      expect(stream.blocks).toHaveLength(1)
      expect(stream.blocks[0]).toMatchObject({ type: 'text', content: '你好，世界。' })

      accumulateStreamEvent('sess_1', { type: 'message_end', messageId: 'msg_1' }, ctx)

      // message_end 后 activeStreams 应清理
      expect(activeStreams.has('msg_1')).toBe(false)

      // 热路径走 appendMessageFast（content 由 blocks 投影）
      const store = getSessionStore()
      expect(store.appendMessageFast).toHaveBeenCalledWith('sess_1', expect.objectContaining({
        id: 'msg_1',
        role: 'assistant',
        content: '你好，世界。',
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: 'text', content: '你好，世界。' })
        ])
      }))
    })

    it('tool_call 和 tool_result 累积到 blocks（事实源），落盘时投影 toolCalls', () => {
      const ctx = makeCtx()

      accumulateStreamEvent('sess_1', { type: 'message_start', messageId: 'msg_2' }, ctx)
      accumulateStreamEvent('sess_1', {
        type: 'tool_call',
        messageId: 'msg_2',
        toolCallId: 'tc_1',
        toolName: 'ls',
        args: { path: '.' }
      }, ctx)

      const stream = activeStreams.get('msg_2')!
      expect(stream.blocks).toHaveLength(1)
      expect(stream.blocks[0].type).toBe('tool')
      if (stream.blocks[0].type === 'tool') {
        expect(stream.blocks[0].toolName).toBe('ls')
      }

      accumulateStreamEvent('sess_1', {
        type: 'tool_result',
        messageId: 'msg_2',
        toolCallId: 'tc_1',
        toolName: 'ls',
        result: 'file1.ts\nfile2.ts'
      }, ctx)

      expect(stream.blocks[0].status).toBe('success')
      if (stream.blocks[0].type === 'tool') {
        expect(stream.blocks[0].result).toBe('file1.ts\nfile2.ts')
      }
    })

    it('error 事件应保留已有正文并附加错误后落盘（不得只存错误文案）', () => {
      const ctx = makeCtx()

      accumulateStreamEvent('sess_1', { type: 'message_start', messageId: 'msg_3' }, ctx)
      accumulateStreamEvent('sess_1', { type: 'text_delta', messageId: 'msg_3', delta: '已成功的回复' }, ctx)
      expect(activeStreams.has('msg_3')).toBe(true)

      accumulateStreamEvent('sess_1', { type: 'error', messageId: 'msg_3', error: 'API 超时' }, ctx)
      expect(activeStreams.has('msg_3')).toBe(false)

      const store = getSessionStore()
      expect(store.appendMessageFast).toHaveBeenCalledWith(
        'sess_1',
        expect.objectContaining({
          id: 'msg_3',
          role: 'assistant',
          interrupted: true,
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: 'text',
              content: expect.stringContaining('已成功的回复')
            })
          ])
        })
      )
      const saved = (store.appendMessageFast as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as {
        blocks?: Array<{ type: string; content?: string }>
        content?: string
      }
      const text = saved.blocks?.find((b) => b.type === 'text')?.content ?? saved.content ?? ''
      expect(text).toContain('已成功的回复')
      expect(text).toContain('API 超时')
    })

    it('attempt_failed 应保留已完成工具轮次，只清末尾临时输出', () => {
      const ctx = makeCtx()
      accumulateStreamEvent('sess_1', { type: 'message_start', messageId: 'msg_af' }, ctx)
      accumulateStreamEvent(
        'sess_1',
        {
          type: 'tool_call',
          messageId: 'msg_af',
          toolCallId: 'tc1',
          toolName: 'ls',
          args: { path: '.' }
        },
        ctx
      )
      accumulateStreamEvent(
        'sess_1',
        {
          type: 'tool_result',
          messageId: 'msg_af',
          toolCallId: 'tc1',
          toolName: 'ls',
          result: 'ok'
        },
        ctx
      )
      accumulateStreamEvent('sess_1', { type: 'text_delta', messageId: 'msg_af', delta: '半截回复' }, ctx)

      accumulateStreamEvent(
        'sess_1',
        { type: 'attempt_failed', messageId: 'msg_af', attemptId: 'a1', error: 'timeout' },
        ctx
      )

      const stream = activeStreams.get('msg_af')
      expect(stream).toBeTruthy()
      expect(stream!.blocks.some((b) => b.type === 'tool')).toBe(true)
      expect(stream!.blocks.some((b) => b.type === 'text' && (b as { content: string }).content.includes('半截'))).toBe(
        false
      )
    })

    /**
     * T3-4：cancel 兜底过滤
     * 即使 runtime 层意外漏发了"权限拒绝: 用户拒绝"的 tool_result，
     * 只要在累积期间被 markActiveStreamsCancelled 标记过，message_end 时
     * 也会把这种残留剔除，避免落盘到 session 历史。
     */
    it('cancel 后 message_end 应剔除"权限拒绝: 用户拒绝"残留，但保留正常工具结果', () => {
      const ctx = makeCtx()

      accumulateStreamEvent('sess_1', { type: 'message_start', messageId: 'msg_cancel' }, ctx)

      // 一个正常完成的工具调用
      accumulateStreamEvent('sess_1', {
        type: 'tool_call',
        messageId: 'msg_cancel',
        toolCallId: 'tc_ls',
        toolName: 'ls',
        args: { path: '.' }
      }, ctx)
      accumulateStreamEvent('sess_1', {
        type: 'tool_result',
        messageId: 'msg_cancel',
        toolCallId: 'tc_ls',
        toolName: 'ls',
        result: 'a.txt\nb.txt'
      }, ctx)

      // 一个被 cancel 残留的"权限拒绝"工具调用
      accumulateStreamEvent('sess_1', {
        type: 'tool_call',
        messageId: 'msg_cancel',
        toolCallId: 'tc_bash',
        toolName: 'bash',
        args: { command: 'rm -rf /' }
      }, ctx)
      accumulateStreamEvent('sess_1', {
        type: 'tool_result',
        messageId: 'msg_cancel',
        toolCallId: 'tc_bash',
        toolName: 'bash',
        result: '权限拒绝: 用户拒绝了 "bash" 工具的执行请求'
      }, ctx)

      // 模拟 IPC handler 收到 cancel-execution 命令
      markActiveStreamsCancelled()

      accumulateStreamEvent('sess_1', { type: 'message_end', messageId: 'msg_cancel' }, ctx)

      const store = getSessionStore()
      const lastCall = vi.mocked(store.appendMessageFast).mock.calls.find(
        c => (c[1] as any).id === 'msg_cancel'
      )
      expect(lastCall).toBeDefined()
      const saved = lastCall![1] as any

      // 正常工具结果保留
      expect(saved.toolCalls.map((t: any) => t.id)).toEqual(['tc_ls'])
      // 权限拒绝条目从 blocks 中剔除
      const toolBlockIds = saved.blocks
        .filter((b: any) => b.type === 'tool')
        .map((b: any) => b.toolCallId)
      expect(toolBlockIds).toEqual(['tc_ls'])
    })

    it('未 cancel 的 message_end 不应剔除任何工具结果（即使 result 含权限拒绝字样）', () => {
      const ctx = makeCtx()

      accumulateStreamEvent('sess_1', { type: 'message_start', messageId: 'msg_normal' }, ctx)
      // 模式策略导致的拒绝（非用户主动拒绝），应作为 Agent 真实经历保留
      accumulateStreamEvent('sess_1', {
        type: 'tool_call',
        messageId: 'msg_normal',
        toolCallId: 'tc_w',
        toolName: 'write',
        args: { path: 'a.ts', content: 'x' }
      }, ctx)
      accumulateStreamEvent('sess_1', {
        type: 'tool_result',
        messageId: 'msg_normal',
        toolCallId: 'tc_w',
        toolName: 'write',
        result: '权限拒绝: 当前为 plan 模式，"write" 工具不可用。'
      }, ctx)

      accumulateStreamEvent('sess_1', { type: 'message_end', messageId: 'msg_normal' }, ctx)

      const store = getSessionStore()
      const savedCall = vi.mocked(store.appendMessageFast).mock.calls.find(
        c => (c[1] as any).id === 'msg_normal'
      )
      expect(savedCall).toBeDefined()
      const saved = savedCall![1] as any

      // 模式策略拒绝应保留（非"用户拒绝"）
      expect(saved.toolCalls).toHaveLength(1)
      expect(saved.toolCalls[0].id).toBe('tc_w')
    })
  })
})
