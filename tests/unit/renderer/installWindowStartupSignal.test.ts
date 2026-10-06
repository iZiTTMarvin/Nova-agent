import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installWindowStartupSignal } from '../../../src/renderer/installWindowStartupSignal'
import { useWorkspaceStore } from '../../../src/renderer/stores/useWorkspaceStore'

describe('首次窗口通知复用工作区恢复状态', () => {
  const invoke = vi.fn(async (_channel: string) => {})
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  let cleanup: () => void = () => {}
  const tick = (): void => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
  }

  beforeEach(() => {
    frames.clear()
    invoke.mockClear()
    useWorkspaceStore.setState({ initialized: false, isSessionLoading: false })
    vi.stubGlobal('window', { api: { invoke } })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    })
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => { frames.delete(frame) })
    cleanup = installWindowStartupSignal()
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('等待首次工作区与会话恢复，绘制后只通知一次并释放订阅', () => {
    tick(); tick()
    expect(invoke).not.toHaveBeenCalled()
    useWorkspaceStore.setState({ initialized: true, isSessionLoading: true })
    tick(); tick()
    expect(invoke).not.toHaveBeenCalled()
    useWorkspaceStore.setState({ isSessionLoading: false })
    tick()
    expect(invoke).not.toHaveBeenCalled()
    tick()
    expect(invoke).toHaveBeenCalledWith('window:renderer-ready')
    useWorkspaceStore.setState({ isSessionLoading: true })
    useWorkspaceStore.setState({ isSessionLoading: false })
    tick(); tick()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
  })

  it('绘制期间开始水合会取消旧通知，重新等到恢复完成', () => {
    useWorkspaceStore.setState({ initialized: true })
    tick()
    useWorkspaceStore.setState({ isSessionLoading: true })
    tick(); tick()
    expect(invoke).not.toHaveBeenCalled()
    useWorkspaceStore.setState({ isSessionLoading: false })
    tick(); tick()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('卸载取消等待，StrictMode 重新安装不会重复通知', () => {
    useWorkspaceStore.setState({ initialized: true })
    cleanup()
    tick(); tick()
    expect(invoke).not.toHaveBeenCalled()
    cleanup = installWindowStartupSignal()
    tick(); tick()
    expect(invoke).toHaveBeenCalledTimes(1)
    cleanup()
    useWorkspaceStore.setState({ isSessionLoading: true })
    expect(frames.size).toBe(0)
  })
})
