import { contextBridge, ipcRenderer } from 'electron'
import type { IpcCommandChannel, IpcCommands, IpcEventChannel, IpcEvents } from '../shared/ipc/types'

/**
 * 类型安全的 IPC invoke 封装
 * 只允许调用已定义的命令 channel，参数和返回值有完整类型推导
 */
function invoke<C extends IpcCommandChannel>(
  channel: C,
  ...args: IpcCommands[C]['params'] extends void ? [] : [IpcCommands[C]['params']]
): Promise<IpcCommands[C]['result']> {
  return ipcRenderer.invoke(channel, ...args)
}

/**
 * 订阅 main → renderer 事件
 * 返回取消订阅函数
 */
function on<C extends IpcEventChannel>(
  channel: C,
  callback: (data: IpcEvents[C]) => void
): () => void {
  const handler = (_event: Electron.IpcRendererEvent, data: IpcEvents[C]) => {
    callback(data)
  }
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

/**
 * 移除指定事件的所有监听器
 */
function removeAllListeners(channel: IpcEventChannel): void {
  ipcRenderer.removeAllListeners(channel)
}

/**
 * Preload 暴露给 renderer 的 API 接口
 * renderer 通过 window.api.invoke / window.api.on / window.api.removeAllListeners 调用
 */
const api = {
  invoke,
  on,
  removeAllListeners
}

contextBridge.exposeInMainWorld('api', api)
