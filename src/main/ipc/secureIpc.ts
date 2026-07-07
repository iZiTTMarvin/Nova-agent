/**
 * IPC 安全包装层
 *
 * 统一校验 event.sender 必须来自主窗口主 frame，拒绝 iframe / 伪造来源的 invoke。
 * 所有 handler 通过本模块的 handle() 注册，内部逻辑无需散落校验代码。
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { getMainWindow } from '../mainWindowRef'
import { mainLog } from '../logger'

/** 与 ipcMain.handle 同签名，套壳后自动校验 sender */
export function handle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => any
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event, channel)
    return listener(event, ...args)
  })
}

function assertTrustedSender(event: IpcMainInvokeEvent, channel: string): void {
  const mainWindow = getMainWindow()
  const trusted = mainWindow?.webContents

  if (!trusted) {
    mainLog.error(`[secureIpc] 拒绝 IPC channel=${channel}：主窗口未就绪`)
    throw new Error('IPC 调用被拒绝：主窗口未就绪')
  }

  if (event.sender !== trusted) {
    mainLog.error(`[secureIpc] 拒绝 IPC channel=${channel}：非主窗口 webContents`)
    throw new Error('IPC 调用被拒绝：来源不可信')
  }

  if (event.senderFrame !== event.sender.mainFrame) {
    mainLog.error(`[secureIpc] 拒绝 IPC channel=${channel}：非主 frame`)
    throw new Error('IPC 调用被拒绝：非主 frame')
  }
}
