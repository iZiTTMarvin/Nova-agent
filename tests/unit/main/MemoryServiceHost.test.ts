/**
 * MemoryServiceHost reconcile 调度：fire-and-forget、并发安全、memoryEnabled 门禁
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const reconcileMock = vi.fn()
const loadNovaSettingsMock = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/nova-test-userdata'
  }
}))

vi.mock('fs', () => ({
  mkdirSync: vi.fn()
}))

vi.mock('../../../src/runtime/memory/BetterSqliteMemoryDb', () => ({
  openBetterSqliteMemoryDb: vi.fn(() => ({}))
}))

vi.mock('../../../src/runtime/memory/MemoryService', () => ({
  MemoryService: vi.fn().mockImplementation(() => ({
    reconcile: reconcileMock,
    close: vi.fn()
  }))
}))

vi.mock('../../../src/runtime/settings/novaSettings', () => ({
  loadNovaSettings: () => loadNovaSettingsMock()
}))

describe('MemoryServiceHost reconcile 调度', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadNovaSettingsMock.mockReturnValue({
      memoryEnabled: true,
      memoryReconcileOnSearch: false,
      memorySearchLimit: 10,
      memoryScoreFloor: 0.15
    })
  })

  afterEach(async () => {
    const { resetMemoryServiceForTests } = await import(
      '../../../src/main/services/MemoryServiceHost'
    )
    resetMemoryServiceForTests()
  })

  it('scheduleMemoryScopeReconcile 为 fire-and-forget，同步返回不阻塞', async () => {
    const { scheduleMemoryScopeReconcile } = await import(
      '../../../src/main/services/MemoryServiceHost'
    )
    scheduleMemoryScopeReconcile('scope-a')
    expect(reconcileMock).not.toHaveBeenCalled()

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(reconcileMock).toHaveBeenCalledTimes(1)
    expect(reconcileMock).toHaveBeenCalledWith('scope-a')
  })

  it('同一 scope 不重复 reconcile', async () => {
    const { scheduleMemoryScopeReconcile } = await import(
      '../../../src/main/services/MemoryServiceHost'
    )
    scheduleMemoryScopeReconcile('scope-b')
    scheduleMemoryScopeReconcile('scope-b')
    scheduleMemoryScopeReconcile('scope-b')

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(reconcileMock).toHaveBeenCalledTimes(1)
  })

  it('memoryEnabled:false 时跳过 reconcile', async () => {
    loadNovaSettingsMock.mockReturnValue({
      memoryEnabled: false,
      memoryReconcileOnSearch: false,
      memorySearchLimit: 10,
      memoryScoreFloor: 0.15
    })
    const { scheduleMemoryScopeReconcile } = await import(
      '../../../src/main/services/MemoryServiceHost'
    )
    scheduleMemoryScopeReconcile('scope-off')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(reconcileMock).not.toHaveBeenCalled()
  })
})
