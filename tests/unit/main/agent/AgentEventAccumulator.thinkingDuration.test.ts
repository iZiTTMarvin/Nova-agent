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
  upsertTurnDraft: () => {},
  clearTurnDraft: () => {},
  commitTerminal: () => {},
  getSnapshot: () => undefined
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
    permissionPolicy: 'auto',
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
