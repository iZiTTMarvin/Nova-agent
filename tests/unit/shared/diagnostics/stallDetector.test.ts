/**
 * T6-6：stall detector 只认 RunCoordinator「running + 心跳/事件超时」
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createEventStallDetector } from '../../../../src/shared/diagnostics/stallDetector'

describe('createEventStallDetector（RunCoordinator 驱动）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let now = 1_000_000

  beforeEach(() => {
    now = 1_000_000
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('waiting_user 时即使间隔很长也不报 STALL', () => {
    const mark = createEventStallDetector({
      thresholdMs: 100,
      now: () => now,
      getRunLiveness: () => ({
        status: 'waiting_user',
        lastHeartbeatAt: now,
        expectHeartbeat: false
      })
    })
    mark('permission_request')
    now += 5_000
    mark('tool_result')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('running 且事件间隔超时 → 报 STALL', () => {
    const mark = createEventStallDetector({
      thresholdMs: 100,
      now: () => now,
      getRunLiveness: () => ({
        status: 'running',
        lastHeartbeatAt: now,
        expectHeartbeat: true
      })
    })
    mark('text_delta')
    now += 500
    mark('text_delta')
    expect(warnSpy).toHaveBeenCalled()
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/\[STALL\]/)
  })

  it('running 且间隔未超时 → 不报', () => {
    const mark = createEventStallDetector({
      thresholdMs: 2_000,
      now: () => now,
      getRunLiveness: () => ({
        status: 'running',
        lastHeartbeatAt: now,
        expectHeartbeat: true
      })
    })
    mark('text_delta')
    now += 50
    mark('text_delta')
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
