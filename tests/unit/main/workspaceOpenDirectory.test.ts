import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openPath: vi.fn(),
  existsSync: vi.fn(),
  workspaceService: {
    setBroadcaster: vi.fn(),
    getState: vi.fn()
  }
}))

vi.mock('../../../src/main/ipc/secureIpc', () => ({
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    mocks.handlers.set(channel, handler)
  }
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  shell: { openPath: mocks.openPath }
}))

vi.mock('fs', () => ({
  existsSync: (p: string) => mocks.existsSync(p)
}))

vi.mock('../../../src/main/services/WorkspaceService', () => ({
  getWorkspaceService: () => mocks.workspaceService
}))

vi.mock('../../../src/main/services/fileSearchService', () => ({
  searchWorkspaceFiles: vi.fn()
}))

import { registerWorkspaceHandler } from '../../../src/main/ipc/workspaceHandler'
import { WORKSPACE_OPEN_DIRECTORY } from '../../../src/shared/ipc/channels'

describe('workspace:open-directory IPC handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    registerWorkspaceHandler(() => null)
  })

  it('缺少或非法路径时抛错', async () => {
    const handler = mocks.handlers.get(WORKSPACE_OPEN_DIRECTORY)
    expect(handler).toBeDefined()

    await expect(handler!({} as never, { path: '' })).rejects.toThrow('缺少目录路径')
    await expect(handler!({} as never, { path: null })).rejects.toThrow('缺少目录路径')
  })

  it('路径不存在时抛错', async () => {
    const handler = mocks.handlers.get(WORKSPACE_OPEN_DIRECTORY)
    mocks.existsSync.mockReturnValue(false)

    await expect(handler!({} as never, { path: 'D:/non/existent' })).rejects.toThrow('工作区目录不存在')
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  it('路径存在时调用 shell.openPath 打开目录', async () => {
    const handler = mocks.handlers.get(WORKSPACE_OPEN_DIRECTORY)
    mocks.existsSync.mockReturnValue(true)
    mocks.openPath.mockResolvedValue('')

    await handler!({} as never, { path: 'D:/projects/my-app' })
    expect(mocks.openPath).toHaveBeenCalledWith('D:/projects/my-app')
  })

  it('shell.openPath 返回错误信息时抛错', async () => {
    const handler = mocks.handlers.get(WORKSPACE_OPEN_DIRECTORY)
    mocks.existsSync.mockReturnValue(true)
    mocks.openPath.mockResolvedValue('Access denied')

    await expect(handler!({} as never, { path: 'D:/projects/my-app' })).rejects.toThrow('无法打开目录：Access denied')
  })
})
