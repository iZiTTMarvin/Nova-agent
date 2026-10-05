/**
 * settingsHandler：默认工作区偏好变更后由 WorkspaceService 重新发布权威投影。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

const { handlers, refreshProjection, saveSettings } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, params?: unknown) => unknown>(),
  refreshProjection: vi.fn(),
  saveSettings: vi.fn((patch: Record<string, unknown>) => ({
    defaultWorkspacePath: null,
    ...patch
  }))
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() }
}))

vi.mock('../../../src/main/ipc/secureIpc', () => ({
  handle: (channel: string, listener: (event: IpcMainInvokeEvent, params?: unknown) => unknown) => {
    handlers.set(channel, listener)
  }
}))

vi.mock('../../../src/runtime/settings/novaSettings', () => ({
  loadNovaSettings: vi.fn(() => ({ defaultWorkspacePath: null })),
  saveNovaSettings: (patch: Record<string, unknown>) => saveSettings(patch)
}))

vi.mock('../../../src/runtime/settings/syncTavilyApiKey', () => ({
  syncTavilyApiKeyFromSettings: vi.fn()
}))

vi.mock('../../../src/main/services/WorkspaceService', () => ({
  getWorkspaceService: () => ({ refreshProjection })
}))

import { registerSettingsHandler } from '../../../src/main/ipc/settingsHandler'

describe('settingsHandler 默认工作区投影', () => {
  beforeEach(() => {
    handlers.clear()
    refreshProjection.mockReset()
    saveSettings.mockClear()
    registerSettingsHandler(() => null)
  })

  it('修改 defaultWorkspacePath 后发布一次 WorkspaceState 权威投影', async () => {
    const listener = handlers.get('settings:set')!
    const path = 'D:\\Nova Workspace'
    const result = await listener({} as IpcMainInvokeEvent, { defaultWorkspacePath: path })

    expect(saveSettings).toHaveBeenCalledWith({ defaultWorkspacePath: path })
    expect(refreshProjection).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ defaultWorkspacePath: path })
  })

  it('修改无关设置不额外广播工作区状态', async () => {
    const listener = handlers.get('settings:set')!
    await listener({} as IpcMainInvokeEvent, { theme: 'dark' })

    expect(refreshProjection).not.toHaveBeenCalled()
  })
})
