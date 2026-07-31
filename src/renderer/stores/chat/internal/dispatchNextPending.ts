import type { ChatStoreApi } from './storeApi'

/**
 * turn boundary（message-end / cancel 兜底）自动派发 steering 队列首条消息。
 *
 * getState 必须在 setState 之外先调用，保证读到的 pendingUserMessages 是最新值；
 * 先同步移除队首避免同一条被多次派发，再复用 sendMessage 主路径
 * （其自身会置 isGenerating 并发起 IPC，与手动发送行为一致）。
 *
 * sendMessage 是 async（含动态 import 与 IPC await），调用方应 await 本函数
 * 以确保 store 状态在 dispatch 后完全稳定（避免读到中间态）。
 */
export async function dispatchNextPendingMessage(api: ChatStoreApi): Promise<void> {
  const { pendingUserMessages, sendMessage, isGenerating } = api.getState()
  if (isGenerating) return
  if (pendingUserMessages.length === 0) return
  const [next, ...rest] = pendingUserMessages
  api.setState({ pendingUserMessages: rest })
  await sendMessage(
    next.text,
    next.images,
    next.autoMode !== undefined ? { autoMode: next.autoMode } : undefined
  )
}
