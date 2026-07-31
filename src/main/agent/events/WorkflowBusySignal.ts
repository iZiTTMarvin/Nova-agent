/**
 * 运行态入口互斥信号。
 *
 * 编排运行期间用户仍然按下发送时，主进程拒绝该消息并发出本信号；
 * renderer 据此提示「编排运行中——是否中断？」，而不是把消息塞进 steering queue。
 */
import type { BrowserWindow } from 'electron'

export interface WorkflowBusyPayload {
  sessionId: string
  runId: string
  workflow: string
  phase: string
}

export function emitWorkflowBusySignal(
  mainWindow: BrowserWindow | null,
  payload: WorkflowBusyPayload
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const webContents = mainWindow.webContents
  if (webContents.isDestroyed()) return
  webContents.send('workflow:busy', payload)
}
