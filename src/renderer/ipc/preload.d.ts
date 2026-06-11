/**
 * renderer 端全局类型声明
 * 声明 preload 通过 contextBridge 暴露的 API 类型
 * 所有 IPC 通信必须通过此 API，renderer 无法直接访问 Node/Electron API
 */
import type { IpcCommandChannel, IpcCommands, IpcEventChannel, IpcEvents } from '../../shared/ipc/types'
import type { NovaSkillApi } from '../../shared/skills/types'

export {}

declare global {
  interface Window {
    nova: {
      skill: NovaSkillApi
    }
    api: {
      invoke: <C extends IpcCommandChannel>(
        channel: C,
        ...args: IpcCommands[C]['params'] extends void ? [] : [IpcCommands[C]['params']]
      ) => Promise<IpcCommands[C]['result']>

      on: <C extends IpcEventChannel>(
        channel: C,
        callback: (data: IpcEvents[C]) => void
      ) => () => void

      removeAllListeners: (channel: IpcEventChannel) => void
    }
  }
}
