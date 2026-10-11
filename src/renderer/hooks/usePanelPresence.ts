/**
 * 面板内容的挂载时机：打开时立即挂载；关闭时等外壳自身的过渡/退场动画真正播完再卸载，
 * 让关闭动画有内容可看。没有动画可等（减弱动效、无动画环境）时同步卸载，不依赖超时兜底。
 */
import { useLayoutEffect, useState, type RefObject } from 'react'

export interface UsePanelPresenceOptions {
  open: boolean
  shellRef: RefObject<HTMLElement | null>
}

export function usePanelPresence({ open, shellRef }: UsePanelPresenceOptions): boolean {
  const [present, setPresent] = useState(open)

  // 在首帧绘制前读取动画：此时本次开合引起的过渡/退场动画已创建
  useLayoutEffect(() => {
    if (open) {
      setPresent(true)
      return
    }
    const animations = shellRef.current?.getAnimations?.() ?? []
    if (animations.length === 0) {
      setPresent(false)
      return
    }
    let cancelled = false
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      // 动画被重新打开打断时不卸载
      if (!cancelled) setPresent(false)
    })
    return () => {
      cancelled = true
    }
  }, [open, shellRef])

  return present
}
