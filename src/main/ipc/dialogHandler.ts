import { BrowserWindow, dialog } from 'electron'
import { handle } from './secureIpc'

export interface ConfirmDialogOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  buttons?: string[]
  defaultId?: number
  cancelId?: number
  title?: string
  message: string
  detail?: string
}

export function registerDialogHandler(): void {
  handle(
    'dialog:confirm',
    async (_event, options: ConfirmDialogOptions): Promise<number> => {
      const win = BrowserWindow.getFocusedWindow()
      const result = await dialog.showMessageBox(win ?? BrowserWindow.getFocusedWindow() ?? undefined!, {
        type: options.type ?? 'question',
        buttons: options.buttons ?? ['取消', '确定'],
        defaultId: options.defaultId ?? 1,
        cancelId: options.cancelId ?? 0,
        title: options.title,
        message: options.message,
        detail: options.detail
      })
      return result.response
    }
  )
}
