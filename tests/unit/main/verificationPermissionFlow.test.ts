import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventBus } from '../../../src/runtime/agent/EventBus'
import {
  accumulateStreamEvent,
  triggerVerificationIfNeeded,
  markActiveStreamsCancelled,
  activeStreams,
  pendingVerificationPermissions,
  type MessageContext
} from '../../../src/main/ipc/agentHandler'
import type { AgentEvent } from '../../../src/runtime/agent/types'

/**
 * agentHandler 真实入口测试
 *
 * 直接 import 并调用 agentHandler 内部导出的函数：
 * - accumulateStreamEvent：流式事件累积
 * - triggerVerificationIfNeeded：验证触发与权限回调
 *
 * 通过 vi.mock 替代 SessionStore/checkpoint 等外部依赖，
 * 测试的是 agentHandler 自己的代码，不是手写的模拟闭包。
 */

// mock sessionHandler 的 getSessionStore，避免真实磁盘 IO
const mockAppendMessage = vi.fn()
const mockStore = {
  appendMessage: mockAppendMessage,
  save: vi.fn(),
  load: vi.fn(),
  getSessionsDir: () => '/tmp/test-sessions'
}
vi.mock('../../../src/main/ipc/sessionHandler', () => ({
  getSessionStore: () => mockStore
}))

// mock checkpoint 的 readManifest，让 hasRealModifications 返回 true
vi.mock('../../../src/runtime/checkpoints/manifest', () => ({
  readManifest: () => ({
    createdFiles: ['src/new-file.ts'],
    modifiedFiles: [],
    deletedFiles: [],
    timestamp: Date.now()
  })
}))

// mock diffState，避免真实文件系统扫描
vi.mock('../../../src/runtime/checkpoints/diffState', () => ({
  buildMessageDiffState: () => ({ diffs: [], reviews: {} })
}))

// mock verification service，避免真实命令执行
vi.mock('../../../src/runtime/verification/service', () => ({
  runVerification: vi.fn()
}))

// mock format
vi.mock('../../../src/runtime/verification/format', () => ({
  formatVerificationSummary: (result: { success: boolean; command: string }) =>
    result.success ? `✓ 验证通过 — ${result.command}` : `✗ 验证失败 — ${result.command}`
}))

import { getSessionStore } from '../../../src/main/ipc/sessionHandler'
import { runVerification } from '../../../src/runtime/verification/service'

function makeCtx(overrides?: Partial<MessageContext>): MessageContext {
  return {
    mode: 'default',
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
    pendingVerificationPermissions.clear()
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
      expect(stream.content).toBe('你好，世界。')

      accumulateStreamEvent('sess_1', { type: 'message_end', messageId: 'msg_1' }, ctx)

      // message_end 后 activeStreams 应清理
      expect(activeStreams.has('msg_1')).toBe(false)

      // 通过 mock 的 getSessionStore 验证 appendMessage 被调用
      const store = getSessionStore()
      expect(store.appendMessage).toHaveBeenCalledWith('sess_1', expect.objectContaining({
        id: 'msg_1',
        role: 'assistant',
        content: '你好，世界。'
      }))
    })

    it('tool_call 和 tool_result 累积到 blocks 和 toolCalls', () => {
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
      expect(stream.toolCalls).toHaveLength(1)
      expect(stream.toolCalls[0].name).toBe('ls')
      expect(stream.blocks).toHaveLength(1)
      expect(stream.blocks[0].type).toBe('tool')

      accumulateStreamEvent('sess_1', {
        type: 'tool_result',
        messageId: 'msg_2',
        toolCallId: 'tc_1',
        toolName: 'ls',
        result: 'file1.ts\nfile2.ts'
      }, ctx)

      expect(stream.toolCalls[0].result).toBe('file1.ts\nfile2.ts')
      expect(stream.blocks[0].status).toBe('success')
    })

    it('error 事件清理累积器并保存错误消息', () => {
      const ctx = makeCtx()

      accumulateStreamEvent('sess_1', { type: 'message_start', messageId: 'msg_3' }, ctx)
      expect(activeStreams.has('msg_3')).toBe(true)

      accumulateStreamEvent('sess_1', { type: 'error', messageId: 'msg_3', error: 'API 超时' }, ctx)
      expect(activeStreams.has('msg_3')).toBe(false)

      const store = getSessionStore()
      expect(store.appendMessage).toHaveBeenCalledWith('sess_1', expect.objectContaining({
        id: 'msg_3',
        role: 'assistant',
        content: 'API 超时'
      }))
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
      const lastCall = vi.mocked(store.appendMessage).mock.calls.find(
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
      const savedCall = vi.mocked(store.appendMessage).mock.calls.find(
        c => (c[1] as any).id === 'msg_normal'
      )
      expect(savedCall).toBeDefined()
      const saved = savedCall![1] as any

      // 模式策略拒绝应保留（非"用户拒绝"）
      expect(saved.toolCalls).toHaveLength(1)
      expect(saved.toolCalls[0].id).toBe('tc_w')
    })
  })

  describe('triggerVerificationIfNeeded — 真实权限回调', () => {
    it('default 模式下 permissionCallback 通过 EventBus 发出 verification_permission_request 事件', async () => {
      // 让 runVerification 直接调用 permissionCallback 并返回其结果
      const mockRunVerification = vi.mocked(runVerification)
      mockRunVerification.mockImplementation(async (options) => {
        if (options.permissionCallback) {
          const granted = await options.permissionCallback('npm test')
          return granted
            ? { command: 'npm test', type: 'test' as const, success: true, output: 'ok', exitCode: 0, durationMs: 100 }
            : null
        }
        return null
      })

      const eventBus = new EventBus()
      const capturedEvents: AgentEvent[] = []
      eventBus.on(e => capturedEvents.push(e))

      const ctx = makeCtx({ eventBus })

      // 调用真实 triggerVerificationIfNeeded
      triggerVerificationIfNeeded('sess_1', 'msg_v1', ctx)

      // 等待异步流程（permissionCallback → emit → 等待 resolve）
      await new Promise(r => setTimeout(r, 50))

      // 验证发出了 verification_permission_request 事件
      const permEvent = capturedEvents.find(e => e.type === 'verification_permission_request')
      expect(permEvent).toBeDefined()
      if (permEvent?.type === 'verification_permission_request') {
        expect(permEvent.command).toBe('npm test')
        expect(permEvent.messageId).toBe('msg_v1')
        expect(permEvent.requestId).toMatch(/^vp_/)

        // 模拟用户通过 IPC 返回 "允许"
        const entry = pendingVerificationPermissions.get(permEvent.requestId)
        expect(entry).toBeDefined()
        entry!.resolve(true)
      }

      // 等待验证结果返回
      await new Promise(r => setTimeout(r, 50))

      // 验证发出了 verification_result 事件
      const resultEvent = capturedEvents.find(e => e.type === 'verification_result')
      expect(resultEvent).toBeDefined()
    })

    it('用户拒绝验证时不发出 verification_result 事件', async () => {
      const mockRunVerification = vi.mocked(runVerification)
      mockRunVerification.mockImplementation(async (options) => {
        if (options.permissionCallback) {
          const granted = await options.permissionCallback('npm test')
          if (!granted) return null
        }
        return null
      })

      const eventBus = new EventBus()
      const capturedEvents: AgentEvent[] = []
      eventBus.on(e => capturedEvents.push(e))

      const ctx = makeCtx({ eventBus })
      triggerVerificationIfNeeded('sess_1', 'msg_v2', ctx)

      await new Promise(r => setTimeout(r, 50))

      const permEvent = capturedEvents.find(e => e.type === 'verification_permission_request')
      expect(permEvent).toBeDefined()
      if (permEvent?.type === 'verification_permission_request') {
        // 用户拒绝
        const entry = pendingVerificationPermissions.get(permEvent.requestId)
        entry!.resolve(false)
      }

      await new Promise(r => setTimeout(r, 50))

      // 不应发出 verification_result
      const resultEvent = capturedEvents.find(e => e.type === 'verification_result')
      expect(resultEvent).toBeUndefined()
    })

    it('验证权限请求超时后会自动清理挂起状态并发出 cleared 事件', async () => {
      vi.useFakeTimers()

      const mockRunVerification = vi.mocked(runVerification)
      mockRunVerification.mockImplementation(async (options) => {
        if (options.permissionCallback) {
          const granted = await options.permissionCallback('npm test')
          if (!granted) return null
        }
        return null
      })

      const eventBus = new EventBus()
      const capturedEvents: AgentEvent[] = []
      eventBus.on(e => capturedEvents.push(e))

      const ctx = makeCtx({ eventBus })
      triggerVerificationIfNeeded('sess_1', 'msg_v3', ctx)

      await vi.runOnlyPendingTimersAsync()

      const requestEvent = capturedEvents.find(e => e.type === 'verification_permission_request')
      expect(requestEvent).toBeDefined()
      if (requestEvent?.type === 'verification_permission_request') {
        expect(pendingVerificationPermissions.has(requestEvent.requestId)).toBe(false)
      }

      const clearedEvent = capturedEvents.find(e => e.type === 'verification_permission_cleared')
      expect(clearedEvent).toBeDefined()

      const resultEvent = capturedEvents.find(e => e.type === 'verification_result')
      expect(resultEvent).toBeUndefined()
    })
  })
})
