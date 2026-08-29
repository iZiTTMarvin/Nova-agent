import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  state: { status: 'idle', currentVersion: '1.0.0' } as const,
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
}))

vi.mock('../../../src/main/ipc/secureIpc', () => ({
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    mocks.handlers.set(channel, handler)
  },
}))

vi.mock('../../../src/main/updater', () => ({
  getAppUpdateState: () => mocks.state,
  checkForAppUpdate: mocks.check,
  downloadAppUpdate: mocks.download,
  quitAndInstallUpdate: mocks.install,
}))

import { registerUpdaterHandler } from '../../../src/main/ipc/updaterHandler'

describe('registerUpdaterHandler', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
    registerUpdaterHandler()
  })

  it('注册完整的更新查询与用户操作命令', async () => {
    expect([...mocks.handlers.keys()]).toEqual([
      'app:update:get-state',
      'app:update:check',
      'app:update:download',
      'app:update:install',
    ])

    await expect(mocks.handlers.get('app:update:get-state')?.({})).resolves.toEqual(mocks.state)
    await mocks.handlers.get('app:update:check')?.({})
    await mocks.handlers.get('app:update:download')?.({})
    await mocks.handlers.get('app:update:install')?.({})

    expect(mocks.check).toHaveBeenCalledOnce()
    expect(mocks.download).toHaveBeenCalledOnce()
    expect(mocks.install).toHaveBeenCalledOnce()
  })
})
