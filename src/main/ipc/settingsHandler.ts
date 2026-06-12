/**
 * 应用级设置 IPC（~/.nova/settings.json）
 */
import { ipcMain } from 'electron'
import { SETTINGS_GET, SETTINGS_SET } from '../../shared/ipc/channels'
import { loadNovaSettings, saveNovaSettings } from '../../runtime/settings/novaSettings'
import type { NovaSettingsDto } from '../../shared/settings/types'

export function registerSettingsHandler(): void {
  ipcMain.handle(SETTINGS_GET, async (): Promise<NovaSettingsDto> => {
    return loadNovaSettings()
  })

  ipcMain.handle(SETTINGS_SET, async (_event, patch: Partial<NovaSettingsDto>): Promise<NovaSettingsDto> => {
    return saveNovaSettings(patch)
  })
}
