/**
 * 人工浏览 chrome：标签条、地址栏、导航与加载失败态。
 * 接管按钮把控制交还用户并撤销当前世代。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconButton } from '@astryxdesign/core/IconButton'
import {
  ArrowLeftIcon,
  CloseIcon,
  HandIcon,
  PlusIcon,
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
import { BROWSER_MAX_LIVE_PAGES } from '../../../shared/browser'
import type { BrowserPageProjection } from '../../../shared/browser'
import { shouldCommitAddressKey } from './addressInput'
import { pagesForSession, pickFocusedPage } from './sessionFilter'
import { BrowserTabFavicon } from './BrowserTabFavicon'
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
  const composeNewPage = useBrowserStore((state) => state.composeNewPage)
  const browserWidth = useLayoutStore((state) => state.browserWidth)
  const pages = pagesForSession(snapshot, sessionId)
  const page = pickFocusedPage(pages, focusedBrowserId, snapshot?.activeBrowserId ?? null)
  const running = useRunStore((state) => selectSessionIsRunning(state, sessionId))

  const [draft, setDraft] = useState(page?.url ?? '')
  const [focused, setFocused] = useState(false)
  const composingRef = useRef(false)
  const justEndedRef = useRef(false)
  const addressRef = useRef<HTMLInputElement>(null)
  const asideRef = useRef<HTMLElement>(null)
  const [dragging, setDragging] = useState(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)
  const latestClientX = useRef(0)
  const rafId = useRef<number | null>(null)

  useEffect(() => {
    if (!focused) setDraft(page?.url ?? '')
  }, [page?.url, page?.browserId, focused])

  useEffect(() => {
    if (!composeNewPage) return
    setDraft('')
    setFocused(true)
    addressRef.current?.focus()
  }, [composeNewPage])

  const commitAddress = useCallback(() => {
    void useBrowserStore.getState().openUrl(draft)
  }, [draft])

  const failed = page?.lifecycle === 'failed' || page?.lifecycle === 'crashed'
  const loadError = page?.loadError ?? null
  const loading = Boolean(page?.loading && !failed && !loadError)
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
  const atPageCap = pages.length >= BROWSER_MAX_LIVE_PAGES

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
      <div className="browser-panel__tabs" role="tablist" aria-label="打开的页面">
        {pages.map((item) => (
          <BrowserPageTab
            key={item.browserId}
            page={item}
            selected={item.browserId === page?.browserId}
          />
        ))}
        <span data-testid="browser-new-tab">
          <IconButton
            label={atPageCap ? '最多同时两个页面' : '新建页面'}
            icon={<PlusIcon size={14} />}
            variant="ghost"
            size="sm"
            onClick={() => {
              const started = useBrowserStore.getState().beginNewPage()
              if (started) {
                setDraft('')
                setFocused(true)
                addressRef.current?.focus()
              }
            }}
          />
        </span>
      </div>
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
          ref={addressRef}
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
            setDraft(composeNewPage ? draft : (page?.url || draft))
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
        <span data-testid="browser-takeover">
          {page?.control.holder === 'user' ? (
            <IconButton
              label="交还 AI 控制"
              icon={<HandIcon size={14} />}
              variant="ghost"
              size="sm"
              isDisabled={!page || page.lifecycle === 'closing'}
              tooltip="交还后 AI 需重新观察页面才能继续操作"
              onClick={() => void useBrowserStore.getState().releaseFocused()}
            />
          ) : (
            <IconButton
              label="接管页面"
              icon={<HandIcon size={14} />}
              variant="ghost"
              size="sm"
              isDisabled={!page || page.lifecycle === 'closing'}
              tooltip={
                page?.control.holder === 'agent'
                  ? '停止 AI 操作并接管页面'
                  : '接管页面'
              }
              onClick={() => void useBrowserStore.getState().claimFocused()}
            />
          )}
        </span>
        <IconButton
          label="关闭页面"
          icon={<CloseIcon size={14} />}
          variant="ghost"
          size="sm"
          onClick={() => void useBrowserStore.getState().closeFocused()}
        />
      </header>
      {loading && <div className="browser-panel__loading" aria-hidden />}
      {lastError && <div className="browser-panel__error" data-testid="browser-surface-error" role="status">{lastError}</div>}
      {page?.notice && (
        <div className="browser-panel__notice" data-testid="browser-guest-notice" role="status">
          <p>{page.notice.message}</p>
          <div className="browser-panel__notice-actions">
            {page.notice.kind === 'popup' && page.notice.targetUrl && (
              <button
                type="button"
                data-testid="browser-popup-open"
                onClick={() => void useBrowserStore.getState().navigateFocused({ kind: 'accept-popup' })}
              >
                在当前页面打开
              </button>
            )}
            <button
              type="button"
              data-testid="browser-notice-dismiss"
              onClick={() => void useBrowserStore.getState().navigateFocused({ kind: 'dismiss-notice' })}
            >
              知道了
            </button>
          </div>
        </div>
      )}
      <div className="browser-panel__stage" data-browser-guest-slot data-testid="browser-guest-slot">
        {loadError && page && !failed && (
          <BrowserLoadError
            page={page}
            onRetry={() => void useBrowserStore.getState().retryFocused()}
          />
        )}
        {failed && page && (
          <BrowserProcessError
            page={page}
            onRetry={() => void useBrowserStore.getState().retryFocused()}
            onClose={() => void useBrowserStore.getState().closePage(page.browserId)}
          />
        )}
        {!page && (
          <div className="browser-panel__empty">在地址栏输入网址开始浏览</div>
        )}
      </div>
    </aside>
  )
}

function BrowserPageTab(props: {
  page: BrowserPageProjection
  selected: boolean
}): ReactNode {
  const { page, selected } = props
  const label = page.title.trim() || hostnameOf(page.url) || '未命名页面'
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={selected}
      data-testid="browser-tab"
      data-browser-id={page.browserId}
      className={`browser-panel__tab${selected ? ' is-active' : ''}`}
      onClick={() => useBrowserStore.getState().focusPage(page.browserId)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        useBrowserStore.getState().focusPage(page.browserId)
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        event.stopPropagation()
        void useBrowserStore.getState().closePage(page.browserId)
      }}
    >
      <BrowserTabFavicon faviconUrl={page.faviconUrl} />
      <span className="browser-panel__tab-title">{label}</span>
      <button
        type="button"
        className="browser-panel__tab-close"
        data-testid="browser-tab-close"
        aria-label={`关闭 ${label}`}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void useBrowserStore.getState().closePage(page.browserId)
        }}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  )
}

function BrowserLoadError(props: {
  page: BrowserPageProjection
  onRetry: () => void
}): ReactNode {
  const { page, onRetry } = props
  const error = page.loadError
  if (!error) return null
  const cert = error.isCertificateError
  const openUrl = error.url || page.url
  return (
    <div className="browser-panel__failed" data-testid="browser-load-error">
      <LoadErrorIcon />
      <h3 className="browser-panel__failed-title">
        {cert ? '该站点的 HTTPS 证书不受信任' : '无法打开该页面'}
      </h3>
      <p className="browser-panel__failed-url">{error.message}</p>
      {cert && (
        <p className="browser-panel__failed-hint" data-testid="browser-load-error-cert-hint">
          可在系统浏览器中打开此地址继续访问。
        </p>
      )}
      {cert && openUrl && (
        <a
          className="browser-panel__failed-external"
          href={openUrl}
          target="_blank"
          rel="noreferrer"
        >
          在系统浏览器打开
        </a>
      )}
      <button
        type="button"
        className="browser-panel__failed-close"
        data-testid="browser-load-error-retry"
        onClick={onRetry}
      >
        重新加载
      </button>
    </div>
  )
}

function BrowserProcessError(props: {
  page: BrowserPageProjection
  onRetry: () => void
  onClose: () => void
}): ReactNode {
  const { page, onRetry, onClose } = props
  const crashed = page.lifecycle === 'crashed'
  return (
    <div className="browser-panel__failed" data-testid="browser-page-error">
      <LoadErrorIcon />
      <h3 className="browser-panel__failed-title">
        {crashed ? '页面进程已停止' : '这个页面没能打开'}
      </h3>
      <p className="browser-panel__failed-url">{page.url}</p>
      <button
        type="button"
        className="browser-panel__failed-close"
        onClick={onRetry}
      >
        重新打开
      </button>
      <button
        type="button"
        className="browser-panel__failed-close"
        onClick={onClose}
      >
        关闭页面
      </button>
    </div>
  )
}

function LoadErrorIcon(): ReactNode {
  return (
    <svg
      className="browser-panel__failed-icon"
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
