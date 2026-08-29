import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppUpdateInfo, AppUpdateSnapshot } from '../../../shared/update'
import { DOWNLOAD_APP_UPDATE, INSTALL_APP_UPDATE } from '../../../shared/ipc/channels'
import { AlertIcon, CheckIcon, CloseIcon, DownloadIcon, SpinnerIcon } from '../../components/Icons'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import './UpdateIndicator.css'

const POPOVER_WIDTH = 360
const VIEWPORT_MARGIN = 12
const POPOVER_GAP = 8
const POPOVER_MAX_HEIGHT = 560

type VisibleUpdateSnapshot =
  | Extract<AppUpdateSnapshot, { status: 'available' | 'downloading' | 'ready' }>
  | Extract<AppUpdateSnapshot, { status: 'error'; operation: 'download' }>

function getVisibleSnapshot(snapshot: AppUpdateSnapshot | null): VisibleUpdateSnapshot | null {
  if (!snapshot) return null
  if (snapshot.status === 'error') {
    return snapshot.operation === 'download' ? snapshot : null
  }
  return snapshot.status === 'available' || snapshot.status === 'downloading' || snapshot.status === 'ready'
    ? snapshot
    : null
}

function displayVersion(version: string): string {
  const trimmed = version.trim()
  if (!trimmed) return '新版本'
  return trimmed.toLowerCase().startsWith('v') ? trimmed : `v${trimmed}`
}

function formatReleaseDate(value: string): string {
  if (!value.trim()) return '日期未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date)
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
}

function getUpdateInfo(snapshot: VisibleUpdateSnapshot): AppUpdateInfo {
  return snapshot.update
}

function getStatusLabel(snapshot: VisibleUpdateSnapshot): string {
  switch (snapshot.status) {
    case 'available':
      return '发现新版本'
    case 'downloading':
      return '正在下载更新'
    case 'ready':
      return '更新已准备好'
    case 'error':
      return '更新下载失败'
  }
}

function getTriggerLabel(snapshot: VisibleUpdateSnapshot): string {
  const info = getUpdateInfo(snapshot)
  switch (snapshot.status) {
    case 'available':
      return `${getStatusLabel(snapshot)}：${displayVersion(info.version)}`
    case 'downloading':
      return `${getStatusLabel(snapshot)}：${Math.round(clampPercent(snapshot.progress.percent))}%`
    case 'ready':
      return `${getStatusLabel(snapshot)}：${displayVersion(info.version)}`
    case 'error':
      return `${getStatusLabel(snapshot)}：${displayVersion(info.version)}`
  }
}

function getActionErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : '操作未完成，请重试。'
}

export interface UpdateIndicatorProps {
  snapshot: AppUpdateSnapshot | null
}

export const UpdateIndicator: React.FC<UpdateIndicatorProps> = ({ snapshot }) => {
  const visibleSnapshot = getVisibleSnapshot(snapshot)
  const [isOpen, setIsOpen] = useState(false)
  const [isActionPending, setIsActionPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [popoverPosition, setPopoverPosition] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const wasOpenRef = useRef(false)

  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const popoverWidth = Math.min(POPOVER_WIDTH, Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2))
    const spaceRight = viewportWidth - rect.right - VIEWPORT_MARGIN
    const spaceAbove = rect.top - VIEWPORT_MARGIN
    const spaceBelow = viewportHeight - rect.bottom - VIEWPORT_MARGIN
    const openRight = spaceRight >= popoverWidth || spaceRight >= rect.left - VIEWPORT_MARGIN
    const preferredLeft = openRight
      ? rect.right + POPOVER_GAP
      : Math.max(VIEWPORT_MARGIN, rect.left - popoverWidth - POPOVER_GAP)
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, preferredLeft),
      Math.max(VIEWPORT_MARGIN, viewportWidth - popoverWidth - VIEWPORT_MARGIN)
    )
    const openUp = spaceAbove >= spaceBelow
    const availableHeight = Math.max(180, (openUp ? spaceAbove : spaceBelow) - POPOVER_GAP)

    setPopoverPosition({
      left,
      maxHeight: Math.min(POPOVER_MAX_HEIGHT, availableHeight),
      ...(openUp
        ? { bottom: viewportHeight - rect.top + POPOVER_GAP }
        : { top: rect.bottom + POPOVER_GAP })
    })
  }, [])

  const closePopover = useCallback(() => {
    setIsOpen(false)
  }, [])

  const togglePopover = useCallback(() => {
    if (!visibleSnapshot) return
    if (isOpen) {
      closePopover()
      return
    }
    setActionError(null)
    updatePopoverPosition()
    setIsOpen(true)
  }, [closePopover, isOpen, updatePopoverPosition, visibleSnapshot])

  const invokeUpdateAction = useCallback(async (
    channel: typeof DOWNLOAD_APP_UPDATE | typeof INSTALL_APP_UPDATE
  ) => {
    if (isActionPending) return
    setIsActionPending(true)
    setActionError(null)
    try {
      await window.api.invoke(channel)
    } catch (error) {
      setActionError(getActionErrorMessage(error))
    } finally {
      setIsActionPending(false)
    }
  }, [isActionPending])

  useEffect(() => {
    if (!visibleSnapshot) {
      setIsOpen(false)
      return
    }
    if (visibleSnapshot.status !== 'error') {
      setActionError(null)
    }
  }, [visibleSnapshot])

  useEffect(() => {
    if (!isOpen) return

    updatePopoverPosition()
    const onResize = () => updatePopoverPosition()
    const onScroll = () => updatePopoverPosition()
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [isOpen, updatePopoverPosition])

  useEffect(() => {
    if (!isOpen) return

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      closePopover()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closePopover()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = popoverRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [closePopover, isOpen])

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      const firstAction = popoverRef.current?.querySelector<HTMLElement>('[data-update-autofocus]')
      ;(firstAction ?? popoverRef.current)?.focus()
    } else if (!isOpen && wasOpenRef.current) {
      triggerRef.current?.focus()
    }
    wasOpenRef.current = isOpen
  }, [isOpen])

  if (!visibleSnapshot) return null

  const info = getUpdateInfo(visibleSnapshot)
  const version = displayVersion(info.version)
  const titleId = `app-update-title-${info.version.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const popoverId = `${titleId}-popover`
  const descriptionId = `${titleId}-description`
  const progress = visibleSnapshot.status === 'downloading'
    ? clampPercent(visibleSnapshot.progress.percent)
    : null

  const popover = isOpen && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          className="app-update-popover"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          tabIndex={-1}
          style={popoverPosition}
        >
          <header className="app-update-popover__header">
            <div className="app-update-popover__heading">
              <span className="app-update-popover__eyebrow">{getStatusLabel(visibleSnapshot)}</span>
              <h2 id={titleId} className="app-update-popover__title">{version} 更新日志</h2>
              <p id={descriptionId} className="app-update-popover__date">
                {formatReleaseDate(info.releaseDate)}
              </p>
              {info.releaseName && (
                <p className="app-update-popover__release-name">{info.releaseName}</p>
              )}
            </div>
            <button
              type="button"
              className="app-update-popover__close"
              aria-label="关闭更新详情"
              onClick={closePopover}
            >
              <CloseIcon size={15} aria-hidden="true" />
            </button>
          </header>

          <div className="app-update-popover__body">
            {visibleSnapshot.status === 'error' && (
              <div className="app-update-popover__error" role="alert">
                <AlertIcon size={16} aria-hidden="true" />
                <span>{visibleSnapshot.message}</span>
              </div>
            )}

            {visibleSnapshot.status === 'downloading' && progress !== null && (
              <div className="app-update-popover__progress-group" aria-label={`已下载 ${Math.round(progress)}%`}>
                <div className="app-update-popover__progress-meta">
                  <span>正在下载更新</span>
                  <span className="app-update-popover__progress-value">{Math.round(progress)}%</span>
                </div>
                <div
                  className="app-update-popover__progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress)}
                  aria-valuetext={`${Math.round(progress)}%`}
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}

            <section className="app-update-popover__notes" aria-label="更新内容">
              {info.releaseNotes.length === 0 ? (
                <p className="app-update-popover__empty">暂无更新说明</p>
              ) : (
                info.releaseNotes.map((releaseNote, index) => (
                  <article key={`${releaseNote.version}-${index}`} className="app-update-popover__note">
                    <h3 className="app-update-popover__note-version">
                      {displayVersion(releaseNote.version || info.version)}
                    </h3>
                    <div className="app-update-popover__note-content">
                      <MarkdownRenderer content={releaseNote.note.trim() || '暂无内容'} />
                    </div>
                  </article>
                ))
              )}
            </section>
          </div>

          {(visibleSnapshot.status === 'available' || visibleSnapshot.status === 'error') && (
            <footer className="app-update-popover__footer">
              <button
                type="button"
                className="app-update-popover__primary-action"
                data-update-autofocus
                disabled={isActionPending}
                onClick={() => void invokeUpdateAction(DOWNLOAD_APP_UPDATE)}
              >
                {isActionPending ? <SpinnerIcon size={15} aria-hidden="true" /> : <DownloadIcon size={15} aria-hidden="true" />}
                <span>{isActionPending ? '正在处理…' : visibleSnapshot.status === 'error' ? '重试下载' : '下载更新'}</span>
              </button>
              {actionError && <p className="app-update-popover__action-error" role="alert">{actionError}</p>}
            </footer>
          )}

          {visibleSnapshot.status === 'ready' && (
            <footer className="app-update-popover__footer">
              <button
                type="button"
                className="app-update-popover__primary-action"
                data-update-autofocus
                disabled={isActionPending}
                onClick={() => void invokeUpdateAction(INSTALL_APP_UPDATE)}
              >
                {isActionPending ? <SpinnerIcon size={15} aria-hidden="true" /> : <CheckIcon size={15} aria-hidden="true" />}
                <span>{isActionPending ? '正在重启…' : '立即重启更新'}</span>
              </button>
              {actionError && <p className="app-update-popover__action-error" role="alert">{actionError}</p>}
            </footer>
          )}
        </div>,
        document.body
      )
    : null

  return (
    <div className="app-update-indicator">
      <button
        ref={triggerRef}
        type="button"
        className={`app-update-indicator__trigger app-update-indicator__trigger--${visibleSnapshot.status === 'error' ? 'error' : visibleSnapshot.status}`}
        aria-label={getTriggerLabel(visibleSnapshot)}
        aria-expanded={isOpen}
        aria-controls={isOpen ? popoverId : undefined}
        title={getTriggerLabel(visibleSnapshot)}
        onClick={togglePopover}
      >
        {visibleSnapshot.status === 'downloading' ? (
          <SpinnerIcon size={16} aria-hidden="true" />
        ) : visibleSnapshot.status === 'ready' ? (
          <CheckIcon size={16} aria-hidden="true" />
        ) : visibleSnapshot.status === 'error' ? (
          <AlertIcon size={16} aria-hidden="true" />
        ) : (
          <DownloadIcon size={16} aria-hidden="true" />
        )}
        <span className="app-update-indicator__dot" aria-hidden="true" />
      </button>
      {popover}
    </div>
  )
}
