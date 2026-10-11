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
        performance.mark('nova-renderer-ready')
        window.dispatchEvent?.(new Event('nova-react-startup-ready'))
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

/** 启动揭幕（品牌层退场）完成后执行，已完成则立即执行；非首屏预取放这里，不与揭幕争主线程 */
export function afterStartupComplete(run: () => void): () => void {
  if (performance.getEntriesByName('nova-startup-complete', 'mark').length > 0) {
    run()
    return () => {}
  }
  window.addEventListener('nova-startup-complete', run, { once: true })
  return () => window.removeEventListener('nova-startup-complete', run)
}
