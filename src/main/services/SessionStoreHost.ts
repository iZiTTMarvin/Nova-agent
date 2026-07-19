/**
 * 主进程 SessionStore 单例宿主。
 * 与 Electron app 路径绑定；agent / ipc / services 均从此读取，禁止业务模块反向依赖 ipc handler。
 */
import { app } from 'electron'
import { SessionStore } from '../../runtime/sessions/SessionStore'

let sessionStore: SessionStore | null = null

/** 初始化（应在 registerSessionHandler 时调用一次） */
export function initSessionStoreHost(appDataPath?: string): SessionStore {
  if (!sessionStore) {
    sessionStore = new SessionStore(appDataPath ?? app.getPath('userData'))
  }
  return sessionStore
}

export function getSessionStore(): SessionStore {
  if (!sessionStore) {
    throw new Error('SessionStore 尚未初始化，请先调用 initSessionStoreHost')
  }
  return sessionStore
}

/** 测试用：重置单例 */
export function resetSessionStoreHostForTests(): void {
  sessionStore = null
}
