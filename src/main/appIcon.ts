import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * 解析应用窗口/任务栏图标路径。
 * - 开发：仓库 build/icon.png
 * - 打包：extraResources 复制到 resources/icon.png
 */
export function resolveAppIconPath(): string | undefined {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'icon.png')]
    : [
        join(app.getAppPath(), 'build', 'icon.png'),
        join(__dirname, '../../build/icon.png')
      ]

  for (const p of candidates) {
    if (existsSync(p)) {
      return p
    }
  }
  return undefined
}
