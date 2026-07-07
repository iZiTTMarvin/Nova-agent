/**
 * 自动更新（electron-updater）
 *
 * 启动后延迟检查 GitHub Release；静默下载完成后通过 IPC 事件通知渲染层提示重启。
 */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { BrowserWindow } from 'electron'
import { mainLog } from './logger'

const CHECK_DELAY_MS = 15_000

let initialized = false

/** 注册 updater 事件；仅在打包态启用 */
export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  if (initialized) return
  initialized = true

  if (!app.isPackaged) {
    mainLog.info('[updater] 开发态跳过自动更新检查')
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = mainLog

  autoUpdater.on('checking-for-update', () => {
    mainLog.info('[updater] 正在检查更新…')
  })

  autoUpdater.on('update-available', (info) => {
    mainLog.info('[updater] 发现新版本', info.version)
  })

  autoUpdater.on('update-not-available', () => {
    mainLog.info('[updater] 当前已是最新版本')
  })

  autoUpdater.on('error', (err) => {
    mainLog.error('[updater] 检查/下载失败', err)
  })

  autoUpdater.on('download-progress', (progress) => {
    mainLog.info('[updater] 下载进度', `${Math.round(progress.percent)}%`)
  })

  autoUpdater.on('update-downloaded', (info) => {
    mainLog.info('[updater] 更新已下载，等待用户重启', info.version)
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('app:update-downloaded', { version: info.version })
    }
  })

  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((err) => {
      mainLog.error('[updater] checkForUpdates 失败', err)
    })
  }, CHECK_DELAY_MS)
}

/** 用户确认后安装已下载的更新 */
export function quitAndInstallUpdate(): void {
  autoUpdater.quitAndInstall()
}
