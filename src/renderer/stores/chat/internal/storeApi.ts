import type { ChatState } from '../types'

/**
 * 内部异步协调器访问 chat store 的最小端口。
 * getState 必须传函数而非快照，避免跨 await 读取陈旧状态。
 */
export interface ChatStoreApi {
  getState: () => ChatState
  setState: (patch: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void
}
