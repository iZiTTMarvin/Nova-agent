import { handle } from './secureIpc'
import {
  DEV_MAIN_LOOP_LAG_RESET,
  DEV_MAIN_LOOP_LAG_SNAPSHOT
} from '../../shared/ipc/channels'
import { getMainLoopLagApi } from '../diagnostics/mainLoopLagMonitor'

/**
 * 开发环境诊断 IPC（主进程 event-loop lag 等）
 * 仅注册 handler，不改动业务路径。
 */
export function registerDevDiagnosticsHandlers(): void {
  if (process.env.NODE_ENV !== 'development') return

  handle(DEV_MAIN_LOOP_LAG_SNAPSHOT, () => {
    return getMainLoopLagApi().snapshot()
  })

  handle(DEV_MAIN_LOOP_LAG_RESET, () => {
    getMainLoopLagApi().reset()
  })
}
