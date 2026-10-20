/**
 * 可视化帧宿主：一个快照地址对应一个沙箱 iframe。
 *
 * src 在挂载时一次确定（含首帧主题），之后的主题与慢放变化经桥下发，绝不改写 src——
 * 主进程导航策略会拒绝已加载快照的帧再次导航；需要重载时由上层换 key 重新挂载。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  buildVisualizationFrameSrc,
  VISUALIZATION_MIN_HEIGHT,
  type HostBridgeMessage,
  type VisualizationDocumentStatus,
  type VisualizationTheme
} from '../../../shared/visualization'
import {
  connectVisualizationFrame,
  createUserIntentGate,
  createVisualizationFramePoster
} from './visualizationBridgeHost'

/** 帧文档与桥脚本都由本地协议同步装配：超过该时限仍未握手即视为加载失败 */
const READY_TIMEOUT_MS = 15_000
const MAX_CACHED_HEIGHTS = 200

/** 首次测得高度之前的占位高度；生成中的卡片沿用同一高度，帧挂载时不跳动 */
export const VISUALIZATION_PLACEHOLDER_HEIGHT = 160

/** 虚拟列表滚出再滚回会重挂载帧：记住上次高度，重载期间不塌陷 */
const inlineHeights = new Map<string, number>()

function rememberInlineHeight(uri: string, height: number): void {
  inlineHeights.delete(uri)
  inlineHeights.set(uri, height)
  if (inlineHeights.size > MAX_CACHED_HEIGHTS) {
    const oldest = inlineHeights.keys().next().value
    if (oldest !== undefined) inlineHeights.delete(oldest)
  }
}

export interface VisualizationFrameHandlers {
  onReady: (status: VisualizationDocumentStatus) => void
  onTimeout: () => void
  onAnimated: () => void
  onRuntimeError: (message: string) => void
  onUserEvent: (name: string, data: unknown) => void
  /** 内容高于宿主给的高度上限：产物内部会出现滚动区，宿主据此提示 */
  onOverflow?: (overflowing: boolean) => void
}

export interface VisualizationFrameProps extends VisualizationFrameHandlers {
  uri: string
  title: string
  theme: VisualizationTheme
  motionScale: number
  maxHeight: number
  /** 内联帧的高度跨挂载缓存；展开视图宽度不同，不共用缓存 */
  cacheHeight?: boolean
}

export const VisualizationFrame: React.FC<VisualizationFrameProps> = React.memo(function VisualizationFrame(props) {
  const { uri, title, theme, motionScale, maxHeight, cacheHeight = false } = props
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const handlersRef = useRef<VisualizationFrameHandlers>(props)
  const stateRef = useRef({ theme, motionScale })
  const postRef = useRef<((message: HostBridgeMessage) => void) | null>(null)
  const readyRef = useRef(false)
  const [src] = useState(() => buildVisualizationFrameSrc(uri, { theme, motionScale, maxHeight }))
  const [height, setHeight] = useState<number | null>(() => (cacheHeight ? inlineHeights.get(uri) ?? null : null))
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    handlersRef.current = props
  })

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const post = createVisualizationFramePoster(iframe)
    const hasUserIntent = createUserIntentGate(iframe)
    if (readyRef.current) postRef.current = post
    const applyHeight = (value: number): void => {
      const next = Math.min(Math.max(Math.ceil(value), VISUALIZATION_MIN_HEIGHT), maxHeight)
      setHeight(next)
      if (cacheHeight) rememberInlineHeight(uri, next)
    }
    const disconnect = connectVisualizationFrame(iframe, message => {
      const handlers = handlersRef.current
      switch (message.kind) {
        case 'ready':
          readyRef.current = true
          postRef.current = post
          post({ kind: 'ack', payload: { ...stateRef.current } })
          applyHeight(message.payload.initialHeight)
          setReady(true)
          handlers.onReady(message.payload.status)
          return
        case 'resize':
          applyHeight(message.payload.height)
          handlers.onOverflow?.(message.payload.height > maxHeight)
          return
        case 'animated':
          handlers.onAnimated()
          return
        case 'error':
          handlers.onRuntimeError(message.payload.message)
          return
        case 'event':
          if (hasUserIntent()) handlers.onUserEvent(message.payload.name, message.payload.data)
          return
        case 'open-external':
          // 交给主窗口的 window open 策略：http(s) 由系统浏览器打开
          if (hasUserIntent()) window.open(message.payload.url, '_blank', 'noopener,noreferrer')
          return
      }
    })
    const timer = readyRef.current
      ? undefined
      : window.setTimeout(() => {
          if (!readyRef.current) handlersRef.current.onTimeout()
        }, READY_TIMEOUT_MS)
    return () => {
      window.clearTimeout(timer)
      disconnect()
      postRef.current = null
    }
  }, [cacheHeight, maxHeight, uri])

  useEffect(() => {
    if (stateRef.current.theme === theme) return
    stateRef.current = { ...stateRef.current, theme }
    postRef.current?.({ kind: 'theme-change', payload: { theme } })
  }, [theme])

  useEffect(() => {
    if (stateRef.current.motionScale === motionScale) return
    stateRef.current = { ...stateRef.current, motionScale }
    postRef.current?.({ kind: 'motion-scale', payload: { motionScale } })
  }, [motionScale])

  return (
    <iframe
      ref={iframeRef}
      className={`visualization-frame${ready ? ' visualization-frame--ready' : ''}`}
      src={src}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ height: height ?? VISUALIZATION_PLACEHOLDER_HEIGHT }}
      data-testid="visualization-frame"
    />
  )
})
