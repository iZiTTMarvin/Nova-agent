import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RunEventRecord, RunSnapshot } from '../../../src/shared/run/types'
import { SnapshotBroadcastCoalescer } from '../../../src/main/services/runSnapshotBroadcast'

function snap(sequence: number, status: RunSnapshot['status'] = 'running'): RunSnapshot {
  return {
    runId: 'run1',
    kind: 'agent',
    workspaceId: '/ws',
    sessionId: 's1',
    messageId: 'm1',
    status,
    sequence,
    pendingInteractions: [],
    currentAttempt: null,
    progress: sequence === 1 ? null : { label: `seq-${sequence}` },
    lastHeartbeatAt: sequence,
    createdAt: 1,
    updatedAt: sequence
  }
}

function event(sequence: number, type: string): RunEventRecord {
  return { sequence, runId: 'run1', type, at: sequence }
}

describe('SnapshotBroadcastCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('心跳 / 工具相位 / 草稿在 50ms 内只发出最新一帧', () => {
    const send = vi.fn()
    const coalescer = new SnapshotBroadcastCoalescer(send)
    coalescer.push(snap(5), event(5, 'heartbeat'))
    coalescer.push(snap(6), event(6, 'tool_phase'))
    coalescer.push(snap(7), event(7, 'turn_draft_upsert'))
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(49)
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1]).toMatchObject({ sequence: 7, type: 'turn_draft_upsert' })
    expect(send.mock.calls[0]?.[0].sequence).toBe(7)
  })

  it('等待用户、交互入队出队与终态立即发出，并先刷出合帧中的最新中间态', () => {
    const send = vi.fn()
    const coalescer = new SnapshotBroadcastCoalescer(send)
    coalescer.push(snap(3), event(3, 'heartbeat'))
    coalescer.push(snap(4, 'waiting_user'), event(4, 'waiting_user'))
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]?.[1]).toMatchObject({ sequence: 3, type: 'heartbeat' })
    expect(send.mock.calls[1]?.[1]).toMatchObject({ sequence: 4, type: 'waiting_user' })

    send.mockClear()
    coalescer.push(snap(5), event(5, 'interaction_enqueued'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1].type).toBe('interaction_enqueued')

    send.mockClear()
    coalescer.push(snap(6), event(6, 'interaction_updated'))
    expect(send).toHaveBeenCalledTimes(1)

    send.mockClear()
    coalescer.push(snap(7, 'running'), event(7, 'resumed_from_waiting'))
    expect(send).toHaveBeenCalledTimes(1)

    send.mockClear()
    coalescer.push(snap(8, 'completed'), event(8, 'terminal'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1].type).toBe('terminal')
  })

  it('并发 run 各保留最新一帧且只共享一个 timer，立即事件不丢失其它 run', () => {
    const frames: Array<[string, number]> = []
    const coalescer = new SnapshotBroadcastCoalescer(snapshot => {
      frames.push([snapshot.runId, snapshot.sequence])
    })
    const push = (runId: string, sequence: number, type = 'heartbeat'): void => {
      coalescer.push({ ...snap(sequence), runId }, { ...event(sequence, type), runId })
    }
    push('A', 1)
    push('B', 10)
    push('A', 2)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(50)
    expect(frames).toEqual([['A', 2], ['B', 10]])
    expect(vi.getTimerCount()).toBe(0)

    push('A', 3)
    push('B', 11)
    push('A', 4, 'terminal')
    expect(frames.slice(2)).toEqual([['A', 3], ['B', 11], ['A', 4]])
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(50)
    expect(frames).toHaveLength(5)
  })

  it('flush 发送期间 cancel 会丢弃所有尚未发送的 run', () => {
    const frames: string[] = []
    const coalescer = new SnapshotBroadcastCoalescer(snapshot => {
      frames.push(snapshot.runId)
      coalescer.cancel()
    })
    for (const runId of ['A', 'B']) {
      coalescer.push({ ...snap(1), runId }, { ...event(1, 'heartbeat'), runId })
    }
    vi.advanceTimersByTime(50)
    expect(frames).toEqual(['A'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancel 后不再发出合帧中的中间态', () => {
    const send = vi.fn()
    const coalescer = new SnapshotBroadcastCoalescer(send)
    coalescer.push(snap(2), event(2, 'heartbeat'))
    coalescer.cancel()
    vi.advanceTimersByTime(50)
    expect(send).not.toHaveBeenCalled()
  })
})
