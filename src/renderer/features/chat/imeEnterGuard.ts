/**
 * 输入框 Enter 的输入法守卫：区分“确认候选”的 Enter 与“发送”的 Enter。
 *
 * 部分输入法在 compositionend 之后紧跟一个 isComposing=false 的 Enter，
 * 只看 isComposing / keyCode 229 会把这次选词误当成发送。
 * 伴生 Enter 与确认选词是同一次按键，必然出现在该键 keyup 之前；
 * 因此只在“组合刚结束、尚未松开任何键、且不超过时间窗”时拦截，
 * 用空格或数字选词后再按 Enter 发送不受影响。
 */
import { useRef } from 'react'

export const IME_TRAILING_ENTER_WINDOW_MS = 500

interface KeyDownLike {
  key: string
  nativeEvent: { isComposing?: boolean; keyCode?: number }
  preventDefault: () => void
}

export interface ImeEnterGuard {
  /** 挂在输入框或其祖先的 onCompositionEnd 上 */
  handleCompositionEnd: () => void
  /** 挂在输入框或其祖先的 onKeyUp 上：确认键松开后，后续 Enter 都是用户的独立按键 */
  handleKeyUp: () => void
  /**
   * 在 keydown 处理最前调用。返回 true 表示该按键属于输入法，调用方应直接返回：
   * 组合中的按键原样交给输入法；伴生 Enter 会被 preventDefault，不换行也不提交。
   */
  interceptKeyDown: (event: KeyDownLike) => boolean
}

export function createImeEnterGuard(now: () => number = () => performance.now()): ImeEnterGuard {
  let compositionEndedAt: number | null = null
  return {
    handleCompositionEnd() {
      compositionEndedAt = now()
    },
    handleKeyUp() {
      compositionEndedAt = null
    },
    interceptKeyDown(event) {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return true
      const endedAt = compositionEndedAt
      // 时间窗只服务紧随其后的一次按键，拦截或放行后都立即复位
      compositionEndedAt = null
      if (event.key === 'Enter' && endedAt !== null && now() - endedAt < IME_TRAILING_ENTER_WINDOW_MS) {
        event.preventDefault()
        return true
      }
      return false
    }
  }
}

/** 每个输入框实例持有一份守卫状态 */
export function useImeEnterGuard(): ImeEnterGuard {
  const guardRef = useRef<ImeEnterGuard | null>(null)
  guardRef.current ??= createImeEnterGuard()
  return guardRef.current
}
