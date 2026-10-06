import { dialog, type BrowserWindow, type NativeImage } from 'electron'
import { mainLog } from './logger'

const STARTUP_TIMEOUT_MS = 15_000
const pendingWindows = new WeakMap<BrowserWindow, () => Promise<void>>()

// ready-to-show 可以由空白帧触发；主窗口只在内容帧完成后揭开。
export function bindWindowStartup(win: BrowserWindow): void {
  const contents = win.webContents
  let timeout: ReturnType<typeof setTimeout>
  let failureDialog: AbortController | undefined
  let capture: Promise<NativeImage> | undefined
  let resolveFrame: () => void = () => {}
  const frameReady = new Promise<void>(resolve => { resolveFrame = resolve })
  const onFrameReady = (): void => { resolveFrame() }
  win.once('ready-to-show', onFrameReady)

  const cleanup = (): void => {
    clearTimeout(timeout)
    pendingWindows.delete(win)
    contents.removeListener('did-fail-load', onLoadFailure)
    contents.removeListener('did-start-navigation', onNavigation)
    win.removeListener('closed', cleanup)
    win.removeListener('ready-to-show', onFrameReady)
    resolveFrame()
    failureDialog?.abort()
    if (!contents.isDestroyed()) contents.setBackgroundThrottling(true)
  }

  const fail = async (detail: string): Promise<void> => {
    if (!pendingWindows.has(win) || failureDialog) return
    clearTimeout(timeout)
    contents.setBackgroundThrottling(true)
    mainLog.error('[window-startup]', detail)
    failureDialog = new AbortController()
    try {
      const result = await dialog.showMessageBox({
        type: 'error',
        title: 'Nova Agent',
        message: '界面未能完成启动。可以重新加载，或关闭应用。',
        detail,
        buttons: ['重新加载', '关闭'],
        defaultId: 0,
        cancelId: 1,
        signal: failureDialog.signal
      })
      if (!pendingWindows.has(win)) return
      failureDialog = undefined
      if (result.response === 0) {
        contents.setBackgroundThrottling(false)
        capture = undefined
        timeout = setTimeout(() => { void fail('等待首个内容帧超时。') }, STARTUP_TIMEOUT_MS)
        contents.reload()
      } else {
        win.close()
      }
    } catch (error) {
      mainLog.error('[window-startup] 无法显示启动错误', error)
      if (pendingWindows.has(win)) win.close()
    }
  }

  const onLoadFailure = (
    _event: Electron.Event, code: number, description: string, _url: string, isMainFrame: boolean
  ): void => {
    if (isMainFrame && code !== -3) void fail(description)
  }

  const onNavigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
    if (event.isMainFrame && !event.isSameDocument) capture = undefined
  }

  pendingWindows.set(win, async () => {
    if (capture) return
    // 确认提交后的合成帧已完成，避免揭开提交前的空白表面。
    const attempt = frameReady.then(() => {
      if (!pendingWindows.has(win)) throw new Error('窗口已关闭。')
      return contents.capturePage()
    })
    capture = attempt
    try {
      const image = await attempt
      if (capture !== attempt || !pendingWindows.has(win) || win.isDestroyed()) return
      if (image.isEmpty()) throw new Error('首屏内容帧为空。')
      if (process.platform === 'win32') {
        cleanup()
        win.setOpacity(1)
        if (!win.isMinimized()) win.focus()
        return
      }
      cleanup()
      win.show()
    } catch (error) {
      if (capture !== attempt || !pendingWindows.has(win)) return
      capture = undefined
      await fail(error instanceof Error ? error.message : '首屏内容帧生成失败。')
    }
  })
  contents.on('did-fail-load', onLoadFailure)
  contents.on('did-start-navigation', onNavigation)
  win.once('closed', cleanup)
  timeout = setTimeout(() => { void fail('等待首个内容帧超时。') }, STARTUP_TIMEOUT_MS)
  // 透明建立 Windows 原生表面，使 Chromium 按可见窗口正常出帧。
  if (process.platform === 'win32') win.showInactive()
}

export async function renderAndShowWindow(win: BrowserWindow): Promise<void> {
  await pendingWindows.get(win)?.()
}
