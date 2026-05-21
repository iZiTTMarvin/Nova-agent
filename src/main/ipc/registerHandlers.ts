import { ipcMain } from 'electron'
import { PING } from '../../shared/ipc/channels'

/**
 * 注册所有 IPC handler（renderer → main 命令）
 * 每个 handler 对应 IpcCommands 中的一个 channel
 */
export function registerIpcHandlers(): void {
  // ping/pong 连通测试
  ipcMain.handle(PING, async () => {
    return 'pong'
  })
}
