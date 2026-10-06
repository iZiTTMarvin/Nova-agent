import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const showMessageBox = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ dialog: { showMessageBox } }))
vi.mock('../../../src/main/logger', () => ({ mainLog: { error: vi.fn() } }))

import { bindWindowStartup, renderAndShowWindow } from '../../../src/main/windowStartup'

class TestWindow extends EventEmitter {
  frame = Promise.resolve({ isEmpty: () => false })
  readonly webContents = Object.assign(new EventEmitter(), {
    reload: () => { this.reloads++ }, capturePage: () => this.frame,
    isDestroyed: () => this.destroyed,
    setBackgroundThrottling: (enabled: boolean) => { this.throttled = enabled }
  })
  throttled = false
  nativeShown = false
  opacity = 0
  skipTaskbar = true
  visible = false
  destroyed = false
  shows = 0
  reloads = 0
  isDestroyed(): boolean { return this.destroyed }
  show(): void { this.visible = true; this.shows++ }
  showInactive(): void { if (!this.nativeShown) this.shows++; this.nativeShown = true }
  setOpacity(value: number): void { this.opacity = value; this.visible = this.nativeShown && value === 1 }
  setSkipTaskbar(value: boolean): void { this.skipTaskbar = value }
  isMinimized(): boolean { return false }
  focus(): void {}
  close(): void { this.destroyed = true; this.emit('closed') }
  asWindow(): BrowserWindow { return this as unknown as BrowserWindow }
}

describe('主窗口首次内容帧生命周期', () => {
  let win: TestWindow
  beforeEach(() => {
    vi.useFakeTimers()
    showMessageBox.mockReset()
    win = new TestWindow()
    bindWindowStartup(win.asWindow())
    win.emit('ready-to-show')
  })
  afterEach(() => {
    win.close()
    vi.useRealTimers()
  })

  it('空白帧不显示窗口，内容帧只显示一次且清理启动监听', async () => {
    win.emit('ready-to-show')
    expect(win.visible).toBe(false)
    await renderAndShowWindow(win.asWindow())
    expect(win.visible).toBe(true)
    if (process.platform === 'win32') expect(win.skipTaskbar).toBe(false)
    expect(win.throttled).toBe(true)
    win.visible = false
    await renderAndShowWindow(win.asWindow())
    expect(win.visible).toBe(false)
    expect(win.shows).toBe(1)
    expect(win.webContents.listenerCount('did-fail-load')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('等待实际内容帧时保持隐藏，并合并 StrictMode 的重复提交通知', async () => {
    let finish: ((image: { isEmpty: () => boolean }) => void) | undefined
    win.frame = new Promise(resolve => { finish = resolve })
    const rendered = renderAndShowWindow(win.asWindow())
    await renderAndShowWindow(win.asWindow())
    expect(win.visible).toBe(false)
    if (process.platform === 'win32') {
      expect(win.nativeShown).toBe(true)
      expect(win.opacity).toBe(0)
      expect(win.throttled).toBe(false)
    }
    finish?.({ isEmpty: () => false })
    await rendered
    expect(win.visible).toBe(true)
    expect(win.shows).toBe(1)
  })

  it('DOM 先提交时等待合成表面建立，不在首个帧之前请求截图', async () => {
    const early = new TestWindow()
    bindWindowStartup(early.asWindow())
    const rendered = renderAndShowWindow(early.asWindow())
    await vi.advanceTimersByTimeAsync(0)
    expect(early.visible).toBe(false)
    early.emit('ready-to-show')
    await rendered
    expect(early.visible).toBe(true)
    early.close()
  })

  it('首次显示前 reload 会丢弃旧文档迟到的帧，等待新文档提交', async () => {
    let finish: ((image: { isEmpty: () => boolean }) => void) | undefined
    win.frame = new Promise(resolve => { finish = resolve })
    const stale = renderAndShowWindow(win.asWindow())
    await vi.advanceTimersByTimeAsync(0)
    win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    finish?.({ isEmpty: () => false })
    await stale
    expect(win.visible).toBe(false)
    win.frame = Promise.resolve({ isEmpty: () => false })
    await renderAndShowWindow(win.asWindow())
    expect(win.visible).toBe(true)
    expect(win.shows).toBe(1)
  })

  it('关闭未显示的窗口释放计时器，迟到通知不会重新显示', async () => {
    win.close()
    await vi.runAllTimersAsync()
    await renderAndShowWindow(win.asWindow())
    expect(win.visible).toBe(false)
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(win.webContents.listenerCount('did-fail-load')).toBe(0)
  })

  it('内容帧超时给出重试入口，重试成功后窗口可用', async () => {
    showMessageBox.mockResolvedValue({ response: 0 })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(win.visible).toBe(false)
    expect(win.reloads).toBe(1)
    expect(win.throttled).toBe(false)
    expect(showMessageBox.mock.calls[0][0].buttons).toEqual(['重新加载', '关闭'])
    await renderAndShowWindow(win.asWindow())
    expect(win.visible).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('主文档加载失败可以关闭，子资源失败和导航取消不终止启动', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })
    win.webContents.emit('did-fail-load', {}, -2, '子资源失败', '', false)
    win.webContents.emit('did-fail-load', {}, -3, '导航取消', '', true)
    expect(showMessageBox).not.toHaveBeenCalled()
    win.webContents.emit('did-fail-load', {}, -6, '文件不存在', '', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(win.destroyed).toBe(true)
    expect(win.visible).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('错误对话框出现后迟到内容帧取消对话框，不执行过期的关闭决定', async () => {
    let finish: ((result: { response: number }) => void) | undefined
    showMessageBox.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(15_000)
    const signal: AbortSignal = showMessageBox.mock.calls[0][0].signal
    await renderAndShowWindow(win.asWindow())
    expect(signal.aborted).toBe(true)
    finish?.({ response: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(win.visible).toBe(true)
    expect(win.destroyed).toBe(false)
    expect(win.shows).toBe(1)
  })
})
