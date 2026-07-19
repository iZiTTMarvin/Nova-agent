import { handle } from './secureIpc'
import { SET_MODE } from '../../shared/ipc/channels'
import type { Mode } from '../../shared/session'
import { setCurrentMode } from '../index'
import { getSessionStore } from '../services/SessionStoreHost'

/**
 * 注册运行模式切换的 IPC 处理器
 * 监听渲染进程的模式变更请求，并记录在主进程全局状态中以供 Agent 调度
 */
export function registerModeHandler(): void {
  handle(SET_MODE, async (_event, params: { mode: Mode; sessionId?: string }): Promise<void> => {
    setCurrentMode(params.mode)

    if (!params.sessionId) return

    const updated = getSessionStore().updateMode(params.sessionId, params.mode)
    if (!updated) {
      throw new Error(`会话 ${params.sessionId} 不存在，无法更新模式`)
    }
  })
}
