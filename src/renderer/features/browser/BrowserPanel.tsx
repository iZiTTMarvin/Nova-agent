/**
 * 人工浏览 chrome：地址栏、导航、加载与失败关闭入口。
 * 接管仅占位；页面状态以 Host 快照为准。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconButton } from '@astryxdesign/core/IconButton'
import {
  ArrowLeftIcon,
  CloseIcon,
  HandIcon,
  RefreshIcon,
  StopIcon
} from '../../components/Icons'
import {
  BROWSER_WIDTH_MAX,
  BROWSER_WIDTH_MIN,
  useLayoutStore
} from '../../stores/useLayoutStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useAgentStore } from '../../stores/useAgentStore'
import { selectSessionIsRunning, useRunStore } from '../../stores/useRunStore'
import { shouldCommitAddressKey } from './addressInput'
import { pagesForSession, pickFocusedPage } from './sessionFilter'
import { useBrowserStore } from './useBrowserStore'
import './BrowserPanel.css'

export function BrowserPanel(props: {
  mode: 'split' | 'expanded'
}): ReactNode {
  const { mode } = props
  const sessionId = useWorkspaceStore((state) => state.currentSessionId)
  const snapshot = useBrowserStore((state) => state.snapshot)
  const focusedBrowserId = useBrowserStore((state) => state.focusedBrowserId)
  const lastError = useBrowserStore((state) => state.lastError)
  const browserWidth = useLayoutStore((state) => state.browserWidth)
  const pages = pagesForSession(snapshot, sessionId)
  const page = pickFocusedPage(pages, focusedBrowserId, snapshot?.activeBrowserId ?? null)
  const running = useRunStore((state) => selectSessionIsRunning(state, sessionId))

  const [draft, setDraft] = useState(page?.url ?? '')
  const [focused, setFocused] = useState(false)
  const composingRef = useRef(false)
  const justEndedRef = useRef(false)
  const asideRef = useRef<HTMLElement>(null)
  const [dragging, setDragging] = useState(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)
  const latestClientX = useRef(0)
  const rafId = useRef<number | null>(null)

  useEffect(() => {
    if (!focused) setDraft(page?.url ?? '')
  }, [page?.url, page?.browserId, focused])

  const commitAddress = useCallback(() => {
    void useBrowserStore.getState().openUrl(draft)
  }, [draft])

  const failed = page?.lifecycle === 'failed' || page?.lifecycle === 'crashed'
  const loading = Boolean(page?.loading && !failed)
  const canNavigate = Boolean(page && !failed && page.lifecycle !== 'closing')

  const widthFromClientX = useCallback((clientX: number) => {
    const delta = dragStartX.current - clientX
    return Math.min(BROWSER_WIDTH_MAX, Math.max(BROWSER_WIDTH_MIN, dragStartWidth.current + delta))
  }, [])

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartX.current = e.clientX
    latestClientX.current = e.clientX
    dragStartWidth.current = useLayoutStore.getState().browserWidth
    setDragging(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }, [])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent): void => {
      latestClientX.current = e.clientX
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(() => {
          rafId.current = null
          const el = asideRef.current
          if (el) el.style.width = `${widthFromClientX(latestClientX.current)}px`
        })
      }
    }
    const onUp = (): void => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current)
        rafId.current = null
      }
      useLayoutStore.getState().setBrowserWidth(widthFromClientX(latestClientX.current))
      setDragging(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (rafId.current !== null) cancelAnimationFrame(rafId.current)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [dragging, widthFromClientX])

  const displayUrl = focused ? draft : (page?.url || draft)
  const width = mode === 'split' ? browserWidth : undefined

  return (
    <aside
      ref={asideRef}
      className={`browser-panel${mode === 'expanded' ? ' browser-panel--expanded' : ''}${dragging ? ' browser-panel--dragging' : ''}`}
      style={width !== undefined ? { width } : undefined}
      data-testid="browser-panel"
      aria-label="内置浏览器"
    >
      {mode === 'split' && (
        <div
          className="browser-panel__resize"
          onMouseDown={onResizeMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整浏览器宽度"
        />
      )}
      <header className="browser-panel__chrome">
        {mode === 'expanded' && (
          <>
            <IconButton
              label="返回对话"
              icon={<ArrowLeftIcon size={14} />}
              variant="ghost"
              size="sm"
              onClick={() => useLayoutStore.getState().closeBrowserSurface()}
            />
            {running && (
              <IconButton
                label="停止当前任务"
                icon={<StopIcon size={14} />}
                variant="ghost"
                size="sm"
                onClick={() => void useAgentStore.getState().cancelExecution()}
              />
            )}
          </>
        )}
        <IconButton
          label="后退"
          icon={<ArrowLeftIcon size={14} />}
          variant="ghost"
          size="sm"
          isDisabled={!canNavigate}
          onClick={() => void useBrowserStore.getState().navigateFocused({ kind: 'back' })}
        />
        <IconButton
          label="前进"
          icon={<ArrowLeftIcon size={14} className="browser-panel__icon-flip" />}
          variant="ghost"
          size="sm"
          isDisabled={!canNavigate}
          onClick={() => void useBrowserStore.getState().navigateFocused({ kind: 'forward' })}
        />
        {loading ? (
          <IconButton
            label="停止加载"
            icon={<StopIcon size={14} />}
            variant="ghost"
            size="sm"
            isDisabled={!page}
            onClick={() => void useBrowserStore.getState().navigateFocused({ kind: 'stop' })}
          />
        ) : (
          <IconButton
            label="刷新"
            icon={<RefreshIcon size={14} />}
            variant="ghost"
            size="sm"
            isDisabled={!canNavigate}
            onClick={() => void useBrowserStore.getState().navigateFocused({ kind: 'reload' })}
          />
        )}
        <input
          className="browser-panel__address"
          data-testid="browser-address"
          value={displayUrl}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="输入网址，在 Nova 中打开"
          aria-label="地址栏"
          onFocus={() => {
            setFocused(true)
            setDraft(page?.url || draft)
          }}
          onBlur={() => setFocused(false)}
          onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            composingRef.current = false
            justEndedRef.current = true
          }}
          onKeyDown={(event) => {
            if (!shouldCommitAddressKey(event)) return
            if (composingRef.current || justEndedRef.current) {
              justEndedRef.current = false
              return
            }
            event.preventDefault()
            commitAddress()
          }}
        />
        <IconButton
          label="接管页面"
          icon={<HandIcon size={14} />}
          variant="ghost"
          size="sm"
          isDisabled
          tooltip="接管将在后续提供"
        />
        <IconButton
          label="关闭页面"
          icon={<CloseIcon size={14} />}
          variant="ghost"
          size="sm"
          onClick={() => void useBrowserStore.getState().closeFocused()}
        />
      </header>
      {pages.length > 1 && (
        <div className="browser-panel__tabs" role="tablist" aria-label="打开的页面">
          {pages.map((item) => (
            <button
              key={item.browserId}
              type="button"
              role="tab"
              aria-selected={item.browserId === page?.browserId}
              className={`browser-panel__tab${item.browserId === page?.browserId ? ' is-active' : ''}`}
              onClick={() => useBrowserStore.getState().focusPage(item.browserId)}
            >
              {item.title || hostnameOf(item.url) || '未命名页面'}
            </button>
          ))}
        </div>
      )}
      {loading && <div className="browser-panel__loading" aria-hidden />}
      {lastError && <div className="browser-panel__error" role="status">{lastError}</div>}
      <div className="browser-panel__stage" data-browser-guest-slot data-testid="browser-guest-slot">
        {failed && page && (
          <div className="browser-panel__failed" data-testid="browser-page-error">
            <p>{page.lifecycle === 'crashed' ? '这个页面已崩溃' : '这个页面没能打开'}</p>
            <p className="browser-panel__failed-url">{page.url}</p>
            <button
              type="button"
              className="browser-panel__failed-close"
              onClick={() => void useBrowserStore.getState().closePage(page.browserId)}
            >
              关闭页面
            </button>
          </div>
        )}
        {!page && (
          <div className="browser-panel__empty">在地址栏输入网址开始浏览</div>
        )}
      </div>
    </aside>
  )
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
