/**
 * 应用级设置 IPC（~/.nova/settings.json）
 */
import type { BrowserWindow } from 'electron'
import { dialog } from 'electron'
import { handle } from './secureIpc'
import { SETTINGS_GET, SETTINGS_SET, SETTINGS_PICK_DIRECTORY } from '../../shared/ipc/channels'
import { loadNovaSettings, saveNovaSettings } from '../../runtime/settings/novaSettings'
import { syncTavilyApiKeyFromSettings } from '../../runtime/settings/syncTavilyApiKey'
import { getWorkspaceService } from '../services/WorkspaceService'
import type { NovaSettingsDto } from '../../shared/settings/types'

export function registerSettingsHandler(getMainWindow: () => BrowserWindow | null): void {
  handle(SETTINGS_GET, async (): Promise<NovaSettingsDto> => {
    return loadNovaSettings()
  })

  handle(SETTINGS_SET, async (_event, patch: Partial<NovaSettingsDto>): Promise<NovaSettingsDto> => {
    const saved = saveNovaSettings(patch)
    syncTavilyApiKeyFromSettings()
    if ('defaultWorkspacePath' in patch) {
      // WorkspaceService 是当前工作区投影 Owner；设置只存偏好，由它重新发布解析后的绝对路径。
      getWorkspaceService().refreshProjection()
    }
    return saved
  })

  // 纯取路径：不建会话、不改当前工作区；用户取消返回 null
  handle(SETTINGS_PICK_DIRECTORY, async (): Promise<string | null> => {
    const window = getMainWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: '选择默认工作区目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
