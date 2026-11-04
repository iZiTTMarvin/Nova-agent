/**
 * 流式预览从 draft 参数派生，与正式发布共用 shared 编译器。
 * 草稿字段闭合后立即收尾并冻结；取消时保留最后一份完整面板预览。
 */
import { useEffect, useRef, useState } from 'react'
import { compileVisualizationDraft } from '../../../shared/visualization/draft'
import { createPartialStringReader } from '../../lib/partialJsonArgs'

/** 解码上限与语言容量分开：超出后保持最后画面，不再逐段重编译 */
export const MAX_PREVIEW_DRAFT_CHARS = 512 * 1024

const THROTTLE_MS = 250
const MAYBE_COMPLETE = /\}\s*$/

export function useStreamingVisualizationHtml(argumentsRaw: string | undefined): string | null {
  const [preview, setPreview] = useState<string | null>(null)
  const readerRef = useRef<ReturnType<typeof createPartialStringReader> | null>(null)
  if (readerRef.current === null) readerRef.current = createPartialStringReader('draft')
  const reader = readerRef.current
  const latestRawRef = useRef<string | undefined>(undefined)
  const lastDecodeAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frozenRef = useRef(false)
  const cappedRef = useRef(false)

  useEffect(() => {
    const clearTimer = (): void => {
      if (timerRef.current === null) return
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const decode = (): void => {
      lastDecodeAtRef.current = Date.now()
      const raw = latestRawRef.current
      if (raw === undefined || cappedRef.current) return
      const value = reader.read(raw)
      if (value === undefined) return
      if (value.length > MAX_PREVIEW_DRAFT_CHARS) {
        cappedRef.current = true
        clearTimer()
        return
      }
      const closed = reader.isClosed()
      const compiled = compileVisualizationDraft(value, { mode: closed ? 'final' : 'preview' })
      if (compiled.status === 'ok') setPreview(compiled.html)
      else if (compiled.status === 'preview' && (compiled.html !== null || compiled.diagnostics.length === 0)) {
        setPreview(compiled.html)
      }
      if (closed) {
        frozenRef.current = true
        clearTimer()
      }
    }

    if (frozenRef.current) return
    if (argumentsRaw === undefined) {
      if (latestRawRef.current === undefined) return
      clearTimer()
      decode()
      frozenRef.current = true
      return
    }
    const firstArrival = latestRawRef.current === undefined
    latestRawRef.current = argumentsRaw
    if (firstArrival || MAYBE_COMPLETE.test(argumentsRaw)) {
      clearTimer()
      decode()
      return
    }
    const elapsed = Date.now() - lastDecodeAtRef.current
    if (elapsed >= THROTTLE_MS) {
      decode()
    } else if (timerRef.current === null) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        decode()
      }, THROTTLE_MS - elapsed)
    }
  }, [argumentsRaw, reader])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [])

  return preview
}
