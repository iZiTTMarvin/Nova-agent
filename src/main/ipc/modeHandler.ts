import { ipcMain } from 'electron'
import { SET_MODE } from '../../shared/ipc/channels'
import type { Mode } from '../../shared/session'
import { setCurrentMode } from '../index'

/**
 * 注册运行模式切换的 IPC 处理器
 * 监听渲染进程的模式变更请求，并记录在主进程全局状态中以供 Agent 调度
 */
export function registerModeHandler(): void {
  ipcMain.handle(SET_MODE, async (_event, mode: Mode): Promise<void> => {
    setCurrentMode(mode)
  })
}
