import { WINDOW_RENDERER_READY } from '../shared/ipc/channels'
import { useWorkspaceStore } from './stores/useWorkspaceStore'

export function installWindowStartupSignal(): () => void {
  let frame = 0
  const notify = (): void => {
    cancelAnimationFrame(frame)
    const state = useWorkspaceStore.getState()
    if (!state.initialized || state.isSessionLoading) return
    // 等待已有会话恢复后的提交与绘制，避免先揭开欢迎页。
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        unsubscribe()
        void window.api.invoke(WINDOW_RENDERER_READY).catch(error => {
          console.error('首屏通知失败', error)
        })
      })
    })
  }
  const unsubscribe = useWorkspaceStore.subscribe(notify)
  notify()
  return () => { unsubscribe(); cancelAnimationFrame(frame) }
}
