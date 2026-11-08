import { contextBridge, ipcRenderer } from 'electron'
import type { IpcCommandChannel, IpcCommands, IpcEventChannel, IpcEvents, IpcInvokeArgs } from '../shared/ipc/types'
import type { RendererMainLoopLagApi } from '../shared/diagnostics/mainLoopLagTypes'
import {
  DEV_MAIN_LOOP_LAG_RESET,
  DEV_MAIN_LOOP_LAG_SNAPSHOT
} from '../shared/ipc/channels'
import { skillApi } from './skill-api'
import { invokeMain } from './remoteInvoke'

/**
 * 类型安全的 IPC invoke 封装
 * 只允许调用已定义的命令 channel，参数和返回值有完整类型推导
 */
function invoke<C extends IpcCommandChannel>(
  channel: C,
  ...args: IpcInvokeArgs<C>
): Promise<IpcCommands[C]['result']> {
  return invokeMain(channel, ...args)
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

// 开发环境：主进程 event-loop lag（与 renderer streamingPerf 对齐的 snapshot/reset API）
if (process.env.NODE_ENV === 'development') {
  const mainLoopLag: RendererMainLoopLagApi = {
    snapshot: () => invokeMain(DEV_MAIN_LOOP_LAG_SNAPSHOT),
    reset: () => invokeMain(DEV_MAIN_LOOP_LAG_RESET)
  }
  contextBridge.exposeInMainWorld('__novaMainLoopLag', mainLoopLag)
}

contextBridge.exposeInMainWorld('nova', { skill: skillApi })

declare global {
  interface Window {
    __novaMainLoopLag?: RendererMainLoopLagApi
  }
}
