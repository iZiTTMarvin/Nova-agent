/**
 * Trigger 菜单几何：把 `/`、`@` 菜单钉在 composer 盒上沿。
 *
 * 官方 useTriggerMenu 以光标为锚点，菜单压在输入框上且随光标左右移动。
 * 这里把 composer 盒的视口几何写成盒上的 CSS 变量——菜单层是盒的 DOM 后代，
 * top layer 提升后仍继承这些变量——由 composerShell.css 消费为固定几何。
 * 菜单打开期间用 rAF 持续校正，覆盖侧栏滑移等不改变盒尺寸的位移动画；
 * 盒元素被条件分支重建时在下一次 update 重新挂观测。
 */
import { useEffect, type RefObject } from 'react'

const MENU_GAP_PX = 6

export function useTriggerMenuGeometry(boxRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let observed: HTMLElement | null = null
    let lastKey = ''

    const update = () => {
      const box = boxRef.current
      if (box && box !== observed) {
        if (observed) resizeObserver.unobserve(observed)
        resizeObserver.observe(box)
        observed = box
      }
      if (!box) return
      const rect = box.getBoundingClientRect()
      const key = `${rect.left}|${rect.top}|${rect.width}`
      if (key === lastKey) return
      lastKey = key
      box.style.setProperty('--trigger-menu-left', `${rect.left}px`)
      box.style.setProperty('--trigger-menu-width', `${rect.width}px`)
      box.style.setProperty(
        '--trigger-menu-bottom',
        `${window.innerHeight - rect.top + MENU_GAP_PX}px`
      )
    }

    const resizeObserver = new ResizeObserver(update)
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)

    let raf = 0
    const tick = () => {
      update()
      raf = requestAnimationFrame(tick)
    }
    const onToggle = (event: Event) => {
      const layer = event.target
      if (!(layer instanceof HTMLElement) || !layer.hasAttribute('popover')) return
      if (!layer.querySelector('.astryx-trigger-menu')) return
      cancelAnimationFrame(raf)
      if (layer.matches(':popover-open')) {
        update()
        raf = requestAnimationFrame(tick)
      }
    }
    document.addEventListener('toggle', onToggle, true)

    return () => {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      document.removeEventListener('toggle', onToggle, true)
      observed?.style.removeProperty('--trigger-menu-left')
      observed?.style.removeProperty('--trigger-menu-width')
      observed?.style.removeProperty('--trigger-menu-bottom')
    }
  }, [boxRef])
}
