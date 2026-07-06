/**
 * MemoryConsolidationHost — drain 防竞态与 fire-and-forget 调度
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const appendMock = vi.fn()
const loadNovaSettingsMock = vi.fn()
const drainMock = vi.fn()
const clearSessionMock = vi.fn()

vi.mock('../../../src/runtime/settings/novaSettings', () => ({
  loadNovaSettings: () => loadNovaSettingsMock()
}))

vi.mock('../../../src/runtime/memory/ObservationCapture', () => ({
  getObservationCaptureForSession: () => ({
    drainWorkingBuffer: drainMock,
    clearSession: clearSessionMock
  }),
  removeObservationCaptureForSession: vi.fn()
}))

vi.mock('../../../src/main/services/MemoryServiceHost', () => ({
  getMemoryService: () => ({
    appendEpisodicSummary: appendMock
  })
}))

describe('MemoryConsolidationHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadNovaSettingsMock.mockReturnValue({
      memoryEnabled: true,
      memoryCaptureEnabled: true,
      memoryEpisodicSummaryEnabled: true
    })
    drainMock.mockReturnValue([
      {
        id: 'obs_1',
        sessionId: 's1',
        messageId: 'm1',
        toolCallId: 'tc1',
        toolName: 'read',
        title: 'read README.md',
        facts: ['content'],
        filesTouched: ['README.md'],
        fingerprint: 'fp',
        capturedAt: Date.now(),
        hadSensitive: false
      }
    ])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('drainAndSchedulePersist 同步 drain、异步写盘', async () => {
    const { drainAndSchedulePersist } = await import(
      '../../../src/main/services/MemoryConsolidationHost'
    )
    drainAndSchedulePersist('s1', '/tmp/ws')
    expect(drainMock).toHaveBeenCalledWith('s1')
    expect(appendMock).not.toHaveBeenCalled()

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(appendMock).toHaveBeenCalledTimes(1)
  })

  it('落盘开关关时仅 drain 不写盘', async () => {
    loadNovaSettingsMock.mockReturnValue({
      memoryEnabled: false,
      memoryCaptureEnabled: true,
      memoryEpisodicSummaryEnabled: true
    })
    const { drainAndSchedulePersist } = await import(
      '../../../src/main/services/MemoryConsolidationHost'
    )
    drainAndSchedulePersist('s1', '/tmp/ws')
    expect(drainMock).toHaveBeenCalled()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(appendMock).not.toHaveBeenCalled()
  })

  it('drainAndPersistSync 同步写盘', async () => {
    const { drainAndPersistSync } = await import(
      '../../../src/main/services/MemoryConsolidationHost'
    )
    drainAndPersistSync('s1', '/tmp/ws')
    expect(drainMock).toHaveBeenCalledWith('s1')
    expect(appendMock).toHaveBeenCalledTimes(1)
  })

  it('handleBufferOverflow 同步 drain、异步写盘', async () => {
    const { handleBufferOverflow } = await import(
      '../../../src/main/services/MemoryConsolidationHost'
    )
    handleBufferOverflow('s1', '/tmp/ws')
    expect(drainMock).toHaveBeenCalledWith('s1')
    expect(appendMock).not.toHaveBeenCalled()

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(appendMock).toHaveBeenCalledTimes(1)
  })

  it('flushCurrentSessionOnQuit 委托 drainAndPersistSync', async () => {
    const { flushCurrentSessionOnQuit } = await import(
      '../../../src/main/services/MemoryConsolidationHost'
    )
    flushCurrentSessionOnQuit('s1', '/tmp/ws')
    expect(drainMock).toHaveBeenCalledWith('s1')
    expect(appendMock).toHaveBeenCalledTimes(1)
  })

  it('flushCurrentSessionOnQuit 缺 session/workspace 时跳过', async () => {
    const { flushCurrentSessionOnQuit } = await import(
      '../../../src/main/services/MemoryConsolidationHost'
    )
    flushCurrentSessionOnQuit(null, '/tmp/ws')
    flushCurrentSessionOnQuit('s1', null)
    expect(drainMock).not.toHaveBeenCalled()
    expect(appendMock).not.toHaveBeenCalled()
  })
})
