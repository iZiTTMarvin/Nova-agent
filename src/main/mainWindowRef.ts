/**
 * 主窗口引用（避免 secureIpc 等模块 import index.ts 触发 app 副作用）
 */
import type { BrowserWindow } from 'electron'

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}
