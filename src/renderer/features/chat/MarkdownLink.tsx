import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { composeBrowserNavigationUrl } from '../browser/addressInput'
import { useBrowserStore } from '../browser/useBrowserStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import './MarkdownLink.css'

export function MarkdownLink(props: {
  href: string
  children: ReactNode
}): ReactNode {
  const { href, children } = props
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const canOpenInNova = composeBrowserNavigationUrl(href) !== null

  useEffect(() => {
    if (!menu) return
    const close = (event: Event): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const onContextMenu = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (!canOpenInNova) return
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY })
  }

  const openInNova = (): void => {
    setMenu(null)
    const workspace = useWorkspaceStore.getState()
    const isLearnSurface = workspace.currentMode === 'learn' && workspace.currentSessionId !== null
    useLayoutStore.getState().openBrowserPane(isLearnSurface)
    void useBrowserStore.getState().openUrl(href)
  }

  return (
    <>
      <a
        className="markdown-link"
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        onContextMenu={onContextMenu}
      >
        {children}
      </a>
      {menu && (
        <div
          ref={menuRef}
          className="markdown-link-menu"
          style={{ top: menu.y, left: menu.x }}
          role="menu"
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
            onClick={() => setMenu(null)}
          >
            在系统浏览器中打开
          </a>
        </div>
      )}
    </>
  )
}
