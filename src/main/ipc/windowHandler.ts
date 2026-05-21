/**
 * 窗口控制 IPC Handler
 * 处理最小化、最大化、关闭等窗口操作
 */
import { ipcMain, BrowserWindow } from 'electron'
import {
  WINDOW_MINIMIZE,
  WINDOW_MAXIMIZE,
  WINDOW_CLOSE,
  WINDOW_IS_MAXIMIZED
} from '../../shared/ipc/channels'

/**
 * 注册窗口控制相关的 IPC handler
 * @param getMainWindow 获取主窗口实例的函数
 */
export function registerWindowHandler(
  getMainWindow: () => BrowserWindow | null
): void {
  ipcMain.handle(WINDOW_MINIMIZE, async () => {
    getMainWindow()?.minimize()
  })

  ipcMain.handle(WINDOW_MAXIMIZE, async () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })

  ipcMain.handle(WINDOW_CLOSE, async () => {
    getMainWindow()?.close()
  })

  ipcMain.handle(WINDOW_IS_MAXIMIZED, async () => {
    return getMainWindow()?.isMaximized() ?? false
  })
}

/**
 * 监听窗口最大化状态变更，通知 renderer 更新 UI
 * @param win 主窗口实例
 */
export function watchWindowMaximizeState(win: BrowserWindow): void {
  const notify = () => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('window:maximize-change', {
        isMaximized: win.isMaximized()
      })
    }
  }
  win.on('maximize', notify)
  win.on('unmaximize', notify)
}
