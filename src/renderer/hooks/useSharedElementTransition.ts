/**
 * 共享元素视图过渡 Hook：
 * 基于 View Transition API 实现缩略图与大图预览之间的圆角与内切裁剪无缝变形，
 * 在不支持 startViewTransition 或开启减弱动效的环境中自动同步降级。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export interface ViewTransitionHandle {
  ready: Promise<void>
  finished: Promise<void>
}

export interface DocumentWithViewTransition {
  startViewTransition?: (callback: () => void) => ViewTransitionHandle
}

export interface UseSharedElementTransitionOptions {
  isOpen: boolean
  originRef?: RefObject<HTMLElement | null>
  originElement?: HTMLElement | null
  transitionName?: string
}

export function getElementBorderRadius(el: HTMLElement, defaultRadius = '0.5rem'): string {
  let curr: HTMLElement | null = el
  for (let i = 0; curr && i < 5; i++) {
    const style = window.getComputedStyle(curr)
    if (
      (curr.tagName === 'IMG' || style.overflow === 'hidden' || style.overflow === 'clip') &&
      style.borderRadius !== '0px' &&
      style.borderRadius !== ''
    ) {
      return style.borderRadius
    }
    curr = curr.parentElement
  }
  return defaultRadius
}

export function computeObjectFitInset(imgEl: HTMLImageElement): string | null {
  const { naturalWidth: nw, naturalHeight: nh } = imgEl
  if (!(nw > 0 && nh > 0)) return null

  const style = window.getComputedStyle(imgEl)
  if (style.objectFit !== 'contain' && style.objectFit !== 'scale-down') return null

  const rect = imgEl.getBoundingClientRect()
  const padL = Number.parseFloat(style.paddingLeft) || 0
  const padT = Number.parseFloat(style.paddingTop) || 0
  const padR = Number.parseFloat(style.paddingRight) || 0
  const padB = Number.parseFloat(style.paddingBottom) || 0

  const availW = rect.width - padL - padR
  const availH = rect.height - padT - padB
  if (availW <= 0 || availH <= 0) return null

  let scale = Math.min(availW / nw, availH / nh)
  if (style.objectFit === 'scale-down') scale = Math.min(scale, 1)

  const renderW = nw * scale
  const renderH = nh * scale

  const insetTop = (availH - renderH) / 2 + padT
  const insetRight = (availW - renderW) / 2 + padR
  const insetBottom = (availH - renderH) / 2 + padB
  const insetLeft = (availW - renderW) / 2 + padL

  return `${(insetTop / rect.height) * 100}% ${(insetRight / rect.width) * 100}% ${(insetBottom / rect.height) * 100}% ${(insetLeft / rect.width) * 100}%`
}

export function useSharedElementTransition({
  isOpen,
  originRef,
  originElement,
  transitionName = 'chat-image-preview'
}: UseSharedElementTransitionOptions) {
  const [isMounted, setIsMounted] = useState(isOpen)
  const targetRef = useRef<HTMLElement | null>(null)
  const prevOpenRef = useRef(isOpen)

  const setTarget = useCallback((el: HTMLElement | null) => {
    targetRef.current = el
  }, [])

  const getTarget = useCallback(() => {
    return targetRef.current
  }, [])

  useEffect(() => {
    const doc = document as unknown as DocumentWithViewTransition
    const supportsViewTransition = typeof doc.startViewTransition === 'function'
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

    if (!supportsViewTransition || prefersReducedMotion) {
      prevOpenRef.current = isOpen
      setIsMounted(isOpen)
      return
    }

    if (prevOpenRef.current === isOpen) {
      return
    }
    prevOpenRef.current = isOpen

    const origin = originElement ?? originRef?.current ?? null
    const root = document.documentElement

    if (isOpen) {
      if (origin) {
        origin.style.setProperty('view-transition-name', transitionName, 'important')
        const radius = getElementBorderRadius(origin, '0.5rem')
        root.style.setProperty('--vt-image-preview-source-radius', radius)

        if (origin instanceof HTMLImageElement) {
          const inset = computeObjectFitInset(origin)
          if (inset) {
            root.style.setProperty('--vt-image-preview-source-inset', inset)
          }
        }
      }

      const transition = doc.startViewTransition!(() => {
        setIsMounted(true)
      })

      void transition.ready.then(() => {
        if (origin) {
          origin.style.removeProperty('view-transition-name')
        }
        const target = targetRef.current
        if (target) {
          target.style.setProperty('view-transition-name', transitionName, 'important')
          const targetRadius = getElementBorderRadius(target, '1rem')
          root.style.setProperty('--vt-image-preview-target-radius', targetRadius)
        }
      })

      void transition.finished.finally(() => {
        const target = targetRef.current
        if (target) {
          target.style.removeProperty('view-transition-name')
        }
        root.style.removeProperty('--vt-image-preview-source-radius')
        root.style.removeProperty('--vt-image-preview-target-radius')
        root.style.removeProperty('--vt-image-preview-source-inset')
      })
    } else {
      const target = targetRef.current
      if (target) {
        target.style.setProperty('view-transition-name', transitionName, 'important')
      }

      const transition = doc.startViewTransition!(() => {
        setIsMounted(false)
      })

      void transition.ready.then(() => {
        if (target) {
          target.style.removeProperty('view-transition-name')
        }
        if (origin) {
          origin.style.setProperty('view-transition-name', transitionName, 'important')
        }
      })

      void transition.finished.finally(() => {
        if (origin) {
          origin.style.removeProperty('view-transition-name')
        }
      })
    }
  }, [isOpen, originRef, originElement, transitionName])

  return {
    isMounted,
    setTarget,
    getTarget
  }
}
