/**
 * 应用级设置 IPC（~/.nova/settings.json）
 */
import { handle } from './secureIpc'
import { SETTINGS_GET, SETTINGS_SET } from '../../shared/ipc/channels'
import { loadNovaSettings, saveNovaSettings } from '../../runtime/settings/novaSettings'
import { syncTavilyApiKeyFromSettings } from '../../runtime/settings/syncTavilyApiKey'
import type { NovaSettingsDto } from '../../shared/settings/types'

export function registerSettingsHandler(): void {
  handle(SETTINGS_GET, async (): Promise<NovaSettingsDto> => {
    return loadNovaSettings()
  })

  handle(SETTINGS_SET, async (_event, patch: Partial<NovaSettingsDto>): Promise<NovaSettingsDto> => {
    const saved = saveNovaSettings(patch)
    syncTavilyApiKeyFromSettings()
    return saved
  })
}
