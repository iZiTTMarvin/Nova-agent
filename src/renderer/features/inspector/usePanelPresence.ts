/**
 * 面板内容的挂载时机：展开时立即挂载；收起时等外壳上的宽度过渡真正播完再卸载，
 * 让收起动画有内容可看。没有过渡可等（减弱动效、无动画环境）时同步卸载，不依赖超时兜底。
 */
import { useLayoutEffect, useState, type RefObject } from 'react'

export interface UsePanelPresenceOptions {
  open: boolean
  shellRef: RefObject<HTMLElement | null>
}

export function usePanelPresence({ open, shellRef }: UsePanelPresenceOptions): boolean {
  const [present, setPresent] = useState(open)

  // 在首帧绘制前读取过渡：此时本次开合引起的宽度过渡已创建
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
      // 过渡被重新展开打断时不卸载
      if (!cancelled) setPresent(false)
    })
    return () => {
      cancelled = true
    }
  }, [open, shellRef])

  return present
}
