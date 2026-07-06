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

vi.mock('../../../src/main/index', () => ({
  setCurrentProjectPath: vi.fn(),
  setCurrentMode: vi.fn()
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

  it('tool_result 触发 diff_update 事件，phase 应为 live，且 diffs 不含 hunks', async () => {
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

    // emitLiveDiffUpdate 已异步化，等待一个事件循环 tick
    await new Promise(r => setImmediate(r))

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

  it('tool_result 触发的实时 diff 更新不应调用 buildMessageDiffState（重计算 LCS）', async () => {
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

    await new Promise(r => setImmediate(r))
    expect(buildMessageDiffStateSpy).not.toHaveBeenCalled()
  })

  it('emitLiveDiffUpdate 应异步触发，不阻塞当前 EventBus 调用栈', async () => {
    const eventBus = new EventBus()
    const captured: AgentEvent[] = []
    eventBus.on(e => captured.push(e))
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

    // 同步阶段：只看到 tool_result 已经被监听器消费；diff_update 尚未发出
    expect(captured.some(e => e.type === 'diff_update')).toBe(false)

    // 等待异步 tick：diff_update 应该追加
    await new Promise(r => setImmediate(r))
    expect(captured.some(e => e.type === 'diff_update')).toBe(true)
  })

  /**
   * T1 竞态：tool_result 排队的 setImmediate 还没执行，message_end 就先到了。
   * 此时累积器已被删除，late live 不应再 emit diff_update（否则会把已写入
   * messageDiffs 的最终数据压回 loading 骨架，且没有后续 final 来清掉）。
   */
  it('message_end 之后到达的 late live 不应再 emit diff_update', async () => {
    const eventBus = new EventBus()
    const captured: AgentEvent[] = []
    eventBus.on(e => captured.push(e))
    const ctx = makeCtx(eventBus)

    accumulateStreamEvent('sess_1', { type: 'message_start', messageId: 'msg_race' }, ctx)
    accumulateStreamEvent('sess_1', {
      type: 'tool_call',
      messageId: 'msg_race',
      toolCallId: 'tc_w',
      toolName: 'write',
      args: { path: 'src/foo.ts' }
    }, ctx)
    accumulateStreamEvent('sess_1', {
      type: 'tool_result',
      messageId: 'msg_race',
      toolCallId: 'tc_w',
      toolName: 'write',
      result: '写入成功'
    }, ctx)

    // 在 setImmediate 真正触发前，message_end 先发生，删除了累积器
    accumulateStreamEvent('sess_1', { type: 'message_end', messageId: 'msg_race' }, ctx)

    // 现在让 setImmediate 执行（late live）
    await new Promise(r => setImmediate(r))

    // 关键断言：累积器已删除时，emitLiveDiffUpdate 不应发出 diff_update
    const diffEvents = captured.filter(e => e.type === 'diff_update')
    expect(diffEvents).toHaveLength(0)
  })
})
