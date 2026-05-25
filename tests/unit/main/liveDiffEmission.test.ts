import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventBus } from '../../../src/runtime/agent/EventBus'
import {
  accumulateStreamEvent,
  activeStreams,
  type MessageContext
} from '../../../src/main/ipc/agentHandler'
import type { AgentEvent } from '../../../src/runtime/agent/types'

/**
 * T1 主进程侧回归：emitLiveDiffUpdate 应只发 phase: 'live' 占位事件，
 * 且不再调用 buildMessageDiffState 计算 LCS（否则会阻塞事件循环）。
 */

vi.mock('../../../src/main/ipc/sessionHandler', () => ({
  getSessionStore: () => ({
    appendMessage: vi.fn(),
    save: vi.fn(),
    load: vi.fn(),
    getSessionsDir: () => '/tmp/test-sessions'
  })
}))

// 模拟 manifest：本轮修改了两个文件，新建了一个
vi.mock('../../../src/runtime/checkpoints/manifest', () => ({
  readManifest: vi.fn(() => ({
    sessionId: 'sess_1',
    messageId: 'msg_1',
    workspaceRoot: '/tmp/project',
    createdFiles: ['src/new.ts'],
    modifiedFiles: ['src/foo.ts', 'src/bar.ts'],
    deletedFiles: [],
    status: 'active',
    createdAt: 1
  }))
}))

// 关键：通过 spy 检测 buildMessageDiffState 是否被调用（不应再被调用）
const buildMessageDiffStateSpy = vi.fn()
vi.mock('../../../src/runtime/checkpoints/diffState', () => ({
  buildMessageDiffState: buildMessageDiffStateSpy
}))

function makeCtx(eventBus: EventBus): MessageContext {
  return {
    mode: 'default',
    workspaceRoot: '/tmp/project',
    sessionsDir: '/tmp/test-sessions',
    eventBus,
    getMainWindow: () => null
  }
}

describe('emitLiveDiffUpdate（T1 主进程侧回归）', () => {
  beforeEach(() => {
    activeStreams.clear()
    buildMessageDiffStateSpy.mockClear()
  })

  it('tool_result 触发 diff_update 事件，phase 应为 live，且 diffs 不含 hunks', () => {
    const eventBus = new EventBus()
    const captured: AgentEvent[] = []
    eventBus.on(e => captured.push(e))

    const ctx = makeCtx(eventBus)

    // 建立流并模拟一次工具调用 + 结果
    accumulateStreamEvent('sess_1', { type: 'message_start', messageId: 'msg_1' }, ctx)
    accumulateStreamEvent('sess_1', {
      type: 'tool_call',
      messageId: 'msg_1',
      toolCallId: 'tc_w',
      toolName: 'write',
      args: { path: 'src/foo.ts' }
    }, ctx)
    accumulateStreamEvent('sess_1', {
      type: 'tool_result',
      messageId: 'msg_1',
      toolCallId: 'tc_w',
      toolName: 'write',
      result: '写入成功'
    }, ctx)

    const diffEvent = captured.find(e => e.type === 'diff_update')
    expect(diffEvent).toBeDefined()
    if (diffEvent?.type === 'diff_update') {
      expect(diffEvent.phase).toBe('live')
      expect(diffEvent.diffs).toHaveLength(3)
      // 关键断言：live 阶段每个 diff 只含 filePath + status，绝不含 hunks
      for (const d of diffEvent.diffs) {
        expect(d).not.toHaveProperty('hunks')
      }
    }
  })

  it('tool_result 触发的实时 diff 更新不应调用 buildMessageDiffState（重计算 LCS）', () => {
    const eventBus = new EventBus()
    const ctx = makeCtx(eventBus)

    accumulateStreamEvent('sess_1', { type: 'message_start', messageId: 'msg_1' }, ctx)
    accumulateStreamEvent('sess_1', {
      type: 'tool_call',
      messageId: 'msg_1',
      toolCallId: 'tc_w',
      toolName: 'write',
      args: { path: 'src/foo.ts' }
    }, ctx)
    accumulateStreamEvent('sess_1', {
      type: 'tool_result',
      messageId: 'msg_1',
      toolCallId: 'tc_w',
      toolName: 'write',
      result: '写入成功'
    }, ctx)

    expect(buildMessageDiffStateSpy).not.toHaveBeenCalled()
  })
})
