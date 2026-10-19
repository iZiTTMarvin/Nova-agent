import { ipcRenderer } from 'electron'

// Electron 给 invoke 失败加的前缀，形如 "Error invoking remote method 'x': Error: 原因"。
const REMOTE_INVOKE_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:\w*Error: )?/

/** 通道前缀是传输细节；渲染层的横幅、对话框只应看到主进程给出的原因。 */
function toRendererError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(message.replace(REMOTE_INVOKE_ERROR_PREFIX, '') || message)
}

/** 与 ipcRenderer.invoke 同签名；所有 preload 桥接都经由这里调用主进程。 */
export const invokeMain: typeof ipcRenderer.invoke = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    throw toRendererError(error)
  })
