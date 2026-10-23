/**
 * 流式预览数据源：从 argumentsRaw 增量解出 html 字段，节流后交给预览帧。
 *
 * html 字段闭合即视为参数收齐：立即补最后一次解码并冻结，之后画面保持不变，
 * 直到正式帧就绪接手。store 提前删除 argumentsRaw（取消、旧路径）时同样用最后登记的值收尾。
 */
import { useEffect, useRef, useState } from 'react'
import { createPartialStringReader } from '../../lib/partialJsonArgs'

/** 预览 HTML 的解码上限：超出后保持最后一次结果，巨型页面不再逐段重解码重推送 */
export const MAX_PREVIEW_HTML_CHARS = 512 * 1024

const THROTTLE_MS = 250
const BODY_START = /<body[\s>]/i
/** 参数对象可能已闭合：跳过节流立即解码，收尾不必再等一个节流窗口 */
const MAYBE_COMPLETE = /\}\s*$/

export interface StreamingVisualizationPreview {
  /** 出现 <body 之后才有值；参数收齐后冻结为完整页面 */
  readonly html: string | null
  /** 参数已收齐，卡片可以提示「正在发布」 */
  readonly complete: boolean
}

const EMPTY_PREVIEW: StreamingVisualizationPreview = { html: null, complete: false }

export function useStreamingVisualizationHtml(argumentsRaw: string | undefined): StreamingVisualizationPreview {
  const [preview, setPreview] = useState<StreamingVisualizationPreview>(EMPTY_PREVIEW)
  const readerRef = useRef<ReturnType<typeof createPartialStringReader> | null>(null)
  if (readerRef.current === null) readerRef.current = createPartialStringReader('html')
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
      if (value.length > MAX_PREVIEW_HTML_CHARS) {
        cappedRef.current = true
        return
      }
      const complete = reader.isClosed()
      if (complete) {
        frozenRef.current = true
        clearTimer()
      }
      setPreview(current => {
        const html = BODY_START.test(value) ? value : current.html
        return current.html === html && current.complete === complete ? current : { html, complete }
      })
    }

    if (frozenRef.current) return
    if (argumentsRaw === undefined) {
      if (latestRawRef.current === undefined) return
      clearTimer()
      decode()
      frozenRef.current = true
      setPreview(current => (current.complete ? current : { html: current.html, complete: true }))
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
      // 尾随定时器读 latestRawRef，保证最新值最终会被解码
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
