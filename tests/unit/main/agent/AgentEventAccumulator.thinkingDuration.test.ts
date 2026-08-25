/**
 * AgentEventAccumulator 思考耗时封存 — 落盘级回归测试
 *
 * 验证 message_start → thinking_delta → 边界事件 → 终态 的完整链路：
 * 交给 SessionStore 持久化的 blocks 上，thinking 块必须带 durationMs，
 * 否则重启后「Thought for Xs」归零。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../../src/runtime/agent'
import type { MessageContext } from '../../../../src/main/agent/events/types'
import type { SessionMessageAppend } from '../../../../src/runtime/sessions/types'
import type { ToolBlock } from '../../../../src/shared/session/types'

const appendMessageFast = vi.fn(
  (_sessionId: string, _message: SessionMessageAppend) =>
    ({ ok: true as const, status: 'appended' as const })
)

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  BrowserWindow: class {}
}))

vi.mock('../../../../src/main/services/SessionStoreHost', () => ({
  getSessionStore: () => ({ appendMessageFast })
}))

const runCoordinatorStub = {
  isExecutionCurrent: () => true,
  upsertTurnDraft: vi.fn(),
  clearTurnDraft: () => {},
  commitTerminal: () => {},
  getSnapshot: vi.fn(() => ({ turnStartedAt: undefined as number | undefined }))
}

vi.mock('../../../../src/main/services/RunCoordinatorHost', () => ({
  getRunCoordinator: () => runCoordinatorStub
}))

import {
  accumulateStreamEvent,
  activeStreams
} from '../../../../src/main/agent/events/AgentEventAccumulator'

function makeCtx(): MessageContext {
  return {
    mode: 'default',
    permissionMode: 'auto',
    workspaceRoot: '',
    sessionsDir: '',
    eventBus: { emit: () => {}, on: () => () => {} } as unknown as MessageContext['eventBus'],
    getMainWindow: () => null,
    runId: 'run_test',
    executionGeneration: 1
  }
}

function persistedBlocks(): Array<{ type: string; content: string; durationMs?: number }> {
  const call = appendMessageFast.mock.calls.at(-1)
  expect(call).toBeDefined()
  const message = call![1]
  return (message.blocks ?? []) as Array<{ type: string; content: string; durationMs?: number }>
}

describe('AgentEventAccumulator 思考耗时封存', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    appendMessageFast.mockClear()
    runCoordinatorStub.getSnapshot.mockReturnValue({ turnStartedAt: undefined })
    activeStreams.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    activeStreams.clear()
  })

  it('thinking → text → message_end：落盘的 thinking 块带 durationMs', () => {
    const ctx = makeCtx()
    const messageId = 'msg_think_text'
    const feed = (event: AgentEvent) => accumulateStreamEvent('sess_test', event, ctx)

    feed({ type: 'message_start', messageId })
    feed({ type: 'thinking_delta', messageId, delta: '先想' })
    vi.setSystemTime(new Date('2026-01-01T00:00:02.400Z'))
    feed({ type: 'text_delta', messageId, delta: '正文' })
    feed({ type: 'message_end', messageId })

    const thinking = persistedBlocks().find(b => b.type === 'thinking')
    expect(thinking?.durationMs).toBe(2400)
  })

  it('终态消息落盘回合起止时刻', () => {
    runCoordinatorStub.getSnapshot.mockReturnValue({ turnStartedAt: 1000 })
    const ctx = makeCtx()
    const messageId = 'msg_turn_duration'
    const feed = (event: AgentEvent) => accumulateStreamEvent('sess_test', event, ctx)

    vi.setSystemTime(2000)
    feed({ type: 'message_start', messageId })
    vi.setSystemTime(3500)
    feed({ type: 'message_end', messageId })

    const message = appendMessageFast.mock.calls.at(-1)![1]
    expect(message.turnStartedAt).toBe(1000)
    expect(message.turnEndedAt).toBe(3500)
  })

  it('thinking 直接进入 message_end（无正文）：落盘仍带 durationMs', () => {
    const ctx = makeCtx()
    const messageId = 'msg_think_end'
    const feed = (event: AgentEvent) => accumulateStreamEvent('sess_test', event, ctx)

    feed({ type: 'message_start', messageId })
    feed({ type: 'thinking_delta', messageId, delta: '只想不说' })
    vi.setSystemTime(new Date('2026-01-01T00:00:01.500Z'))
    feed({ type: 'message_end', messageId })

    const thinking = persistedBlocks().find(b => b.type === 'thinking')
    expect(thinking?.durationMs).toBe(1500)
  })

  it('嵌套工具事件（run_code 沙箱内）不生成持久化工具块', () => {
    const ctx = makeCtx()
    const messageId = 'msg_nested'
    const feed = (event: AgentEvent) => accumulateStreamEvent('sess_test', event, ctx)

    feed({ type: 'message_start', messageId })
    feed({ type: 'tool_call', messageId, toolCallId: 'tc_run_code', toolName: 'run_code', args: {} })
    feed({
      type: 'tool_call',
      messageId,
      toolCallId: 'tc_run_code#nested-1',
      toolName: 'read',
      args: { path: 'a.ts' },
      parentToolCallId: 'tc_run_code'
    })
    feed({
      type: 'tool_result',
      messageId,
      toolCallId: 'tc_run_code#nested-1',
      toolName: 'read',
      result: '文件内容',
      parentToolCallId: 'tc_run_code'
    })
    feed({ type: 'tool_result', messageId, toolCallId: 'tc_run_code', toolName: 'run_code', result: '[return]\n{}' })
    feed({ type: 'message_end', messageId })

    const toolBlocks = persistedBlocks().filter(b => b.type === 'tool') as Array<{ toolCallId?: string }>
    expect(toolBlocks.map(b => b.toolCallId)).toEqual(['tc_run_code'])
  })

  it('thinking 后发生 error：错误终态落盘的 thinking 块也带 durationMs', () => {
    const ctx = makeCtx()
    const messageId = 'msg_think_error'
    const feed = (event: AgentEvent) => accumulateStreamEvent('sess_test', event, ctx)

    feed({ type: 'message_start', messageId })
    feed({ type: 'thinking_delta', messageId, delta: '想到一半出错' })
    vi.setSystemTime(new Date('2026-01-01T00:00:03.100Z'))
    feed({ type: 'error', messageId, error: '上游超时' })

    const thinking = persistedBlocks().find(b => b.type === 'thinking')
    expect(thinking?.durationMs).toBe(3100)
  })

  it('多段思考（thinking→text→thinking→message_end）：两段各自带 durationMs', () => {
    const ctx = makeCtx()
    const messageId = 'msg_two_thinks'
    const feed = (event: AgentEvent) => accumulateStreamEvent('sess_test', event, ctx)

    feed({ type: 'message_start', messageId })
    feed({ type: 'thinking_delta', messageId, delta: '第一段' })
    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'))
    feed({ type: 'text_delta', messageId, delta: '中间正文' })
    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'))
    feed({ type: 'thinking_delta', messageId, delta: '第二段' })
    vi.setSystemTime(new Date('2026-01-01T00:00:08.000Z'))
    feed({ type: 'message_end', messageId })

    const thinkings = persistedBlocks().filter(b => b.type === 'thinking')
    expect(thinkings.map(b => b.durationMs)).toEqual([2000, 3000])
  })
})

describe('AgentEventAccumulator 中断残态收敛', () => {
  beforeEach(() => {
    appendMessageFast.mockClear()
    runCoordinatorStub.upsertTurnDraft.mockClear()
    runCoordinatorStub.getSnapshot.mockReturnValue({ turnStartedAt: undefined })
    activeStreams.clear()
  })
  afterEach(() => {
    activeStreams.clear()
  })

  function lastPersistedToolBlocks(): ToolBlock[] {
    const call = appendMessageFast.mock.calls.at(-1)
    expect(call).toBeDefined()
    const message = call![1]
    return (message.blocks ?? []).filter((b): b is ToolBlock => b.type === 'tool')
  }

  it('tool_call 后无 tool_end 直接 interrupted message_end：落盘无 running 残块', () => {
    const ctx = makeCtx()
    const messageId = 'msg_interrupted_tool'
    const feed = (event: AgentEvent) => accumulateStreamEvent('sess_test', event, ctx)

    feed({ type: 'message_start', messageId })
    feed({
      type: 'tool_call',
      messageId,
      toolCallId: 'tc_save_plan',
      toolName: 'save_plan',
      args: { title: '重构' }
    })
    feed({ type: 'message_end', messageId, interrupted: true })

    // interrupted 消息标志语义保持不变（仍在附带终态消息上）
    const message = appendMessageFast.mock.calls.at(-1)![1]
    expect(message.interrupted).toBe(true)

    // SessionStore 落盘：running 工具块必须收敛为 error，并带可读的中断说明
    const toolBlocks = lastPersistedToolBlocks()
    expect(toolBlocks.map(b => b.status)).toEqual(['error'])
    expect(toolBlocks[0].result).toBe('工具执行被中断')

    // turnDraft finalize receipt 与消息一致：不允许携带 running 残块
    const drafts = runCoordinatorStub.upsertTurnDraft.mock.calls.map(call => call[1] as {
      finalized?: boolean
      blocks: Array<Record<string, unknown>>
    })
    expect(drafts.length).toBeGreaterThan(0)
    const receipt = drafts[drafts.length - 1]
    expect(receipt.finalized).toBe(true)
    expect(
      receipt.blocks
        .filter(b => b.type === 'tool')
        .map(b => b.status)
    ).toEqual(['error'])
  })

  it('tool 执行中发生 error：终态落盘同样无 running 残块', () => {
    const ctx = makeCtx()
    const messageId = 'msg_error_tool'
    const feed = (event: AgentEvent) => accumulateStreamEvent('sess_test', event, ctx)

    feed({ type: 'message_start', messageId })
    feed({
      type: 'tool_call',
      messageId,
      toolCallId: 'tc_write',
      toolName: 'write',
      args: { path: 'a.ts' }
    })
    feed({ type: 'error', messageId, error: '上游超时' })

    const toolBlocks = lastPersistedToolBlocks()
    expect(toolBlocks.map(b => b.status)).toEqual(['error'])
  })
})
