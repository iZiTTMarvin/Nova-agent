/**
 * 诊断包导出 IPC：设置页与错误动作按钮共用的入口。
 */
import { BrowserWindow } from 'electron'
import { handle } from './secureIpc'
import { DIAGNOSTICS_EXPORT } from '../../shared/ipc/channels'
import { exportDiagnostics } from '../diagnostics/diagnosticsExport'

export function registerDiagnosticsHandler(): void {
  handle(DIAGNOSTICS_EXPORT, () =>
    exportDiagnostics(() => BrowserWindow.getFocusedWindow())
  )
}
