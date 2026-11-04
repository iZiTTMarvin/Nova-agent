import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { composeBrowserNavigationUrl } from '../browser/addressInput'
import { useBrowserStore } from '../browser/useBrowserStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import './MarkdownLink.css'

const MENU_VIEWPORT_MARGIN = 8

/**
 * 正文链接：左键交给系统浏览器；右键或菜单键（Shift+F10）弹出「在 Nova 中打开」。
 * 菜单挂到 body：消息列表的虚拟化容器带 transform，fixed 定位在其内部会错位。
 */
export function MarkdownLink(props: {
  href: string
  children: ReactNode
}): ReactNode {
  const { href, children } = props
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const linkRef = useRef<HTMLAnchorElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const canOpenInNova = composeBrowserNavigationUrl(href) !== null

  const closeMenu = (restoreFocus: boolean): void => {
    setMenu(null)
    if (restoreFocus) linkRef.current?.focus()
  }

  useEffect(() => {
    if (!menu) return
    const close = (event: Event): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  // 打开后焦点进入首项，并把菜单收进视口
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!menu || !el) return
    const rect = el.getBoundingClientRect()
    const left = Math.min(menu.x, window.innerWidth - rect.width - MENU_VIEWPORT_MARGIN)
    const top = Math.min(menu.y, window.innerHeight - rect.height - MENU_VIEWPORT_MARGIN)
    el.style.left = `${Math.max(MENU_VIEWPORT_MARGIN, left)}px`
    el.style.top = `${Math.max(MENU_VIEWPORT_MARGIN, top)}px`
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [menu])

  const onContextMenu = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (!canOpenInNova) return
    event.preventDefault()
    // 键盘触发的 contextmenu 没有指针坐标，改为贴着链接下方弹出
    if (event.clientX === 0 && event.clientY === 0) {
      const rect = event.currentTarget.getBoundingClientRect()
      setMenu({ x: rect.left, y: rect.bottom + 4 })
      return
    }
    setMenu({ x: event.clientX, y: event.clientY })
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu(true)
      return
    }
    if (event.key === 'Tab') {
      closeMenu(false)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown'
      ? items[(index + 1) % items.length]
      : items[(index - 1 + items.length) % items.length]
    next?.focus()
  }

  const openInNova = (): void => {
    closeMenu(false)
    const workspace = useWorkspaceStore.getState()
    const isLearnSurface = workspace.currentMode === 'learn' && workspace.currentSessionId !== null
    useLayoutStore.getState().openBrowserPane(isLearnSurface)
    void useBrowserStore.getState().openUrl(href)
  }

  return (
    <>
      <a
        ref={linkRef}
        className="markdown-link"
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        aria-haspopup={canOpenInNova ? 'menu' : undefined}
        onContextMenu={onContextMenu}
      >
        {children}
      </a>
      {menu && createPortal(
        <div
          ref={menuRef}
          className="markdown-link-menu"
          style={{ top: menu.y, left: menu.x }}
          role="menu"
          aria-label="链接操作"
          onKeyDown={onMenuKeyDown}
        >
          <button type="button" role="menuitem" onClick={openInNova}>
            在 Nova 中打开
          </button>
          <a
            className="markdown-link-menu__external"
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            role="menuitem"
            onClick={() => closeMenu(false)}
          >
            在系统浏览器中打开
          </a>
        </div>,
        document.body
      )}
    </>
  )
}
