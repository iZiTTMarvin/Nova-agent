import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * 解析应用窗口/任务栏图标路径。
 * - Windows 开发：仓库 build/icon.ico；其他开发平台使用 build/icon.png
 * - 打包：extraResources 复制到 resources/icon.png
 */
export function resolveAppIconPath(): string | undefined {
  const iconName = !app.isPackaged && process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, iconName)]
    : [
        join(app.getAppPath(), 'build', iconName),
        join(__dirname, '../../build', iconName)
      ]

  for (const p of candidates) {
    if (existsSync(p)) {
      return p
    }
  }
  return undefined
}
