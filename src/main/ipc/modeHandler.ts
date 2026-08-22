import { handle } from './secureIpc'
import { SET_MODE } from '../../shared/ipc/channels'
import type { Mode } from '../../shared/session'
import { getWorkspaceService } from '../services/WorkspaceService'

/** 注册运行模式切换 IPC，状态变更统一委托 WorkspaceService。 */
export function registerModeHandler(): void {
  handle(SET_MODE, async (_event, params: { mode: Mode; sessionId?: string }): Promise<void> => {
    getWorkspaceService().setMode({
      mode: params.mode,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      source: 'user'
    })
  })
}
