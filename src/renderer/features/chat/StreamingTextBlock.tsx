/**
 * StreamingTextBlock — 流式期间的文本块渲染
 *
 * 封装 useStreamingRenderPool + MarkdownRenderer：
 * - 流式期间用 render pool 逐步放出字符（打字机效果）
 * - 流式结束后直接显示完整内容
 * - renderedLength 变化时通过 onRenderPoolTick 回调通知外部（用于自动滚动）
 */
import React, { useEffect, useRef } from 'react'
import { useStreamingRenderPool, type RenderStyle } from '../../hooks/useStreamingRenderPool'
import { MarkdownRenderer } from './MarkdownRenderer'

export interface StreamingTextBlockProps {
  /** 上游完整文本（来自 store 的 message block.content） */
  fullContent: string
  /** 是否处于流式生成中 */
  isStreaming: boolean
  /** 渲染风格：agile (32ms 帧) | elegant (36ms 帧) */
  style?: RenderStyle
  /**
   * render pool 每次 tick（renderedLength 变化）时的回调。
   * ChatPanel 用它触发自动滚动，让滚动节奏与字符放出节奏同步。
   */
  onRenderPoolTick?: () => void
}

/**
 * 流式文本块。流式期间走 useStreamingRenderPool 控制放出节奏，
 * 结束后一次性渲染完整内容。
 * React.memo 包裹：fullContent 是 string，浅比较即可命中。
 */
export const StreamingTextBlock = React.memo(function StreamingTextBlock({
  fullContent,
  isStreaming,
  style = 'agile',
  onRenderPoolTick
}: StreamingTextBlockProps) {
  const pool = useStreamingRenderPool(fullContent, isStreaming, style)
  const lastReportedLengthRef = useRef<number>(pool.renderedLength)

  // 每次 renderedLength 变化时通知外部
  useEffect(() => {
    if (!isStreaming) return
    if (pool.renderedLength === lastReportedLengthRef.current) return
    lastReportedLengthRef.current = pool.renderedLength
    onRenderPoolTick?.()
  }, [pool.renderedLength, isStreaming, onRenderPoolTick])

  // 流式期间用 pool 控速；非流式直接显示完整内容
  if (!isStreaming) {
    if (!fullContent) return null
    return <MarkdownRenderer content={fullContent} isStreaming={false} />
  }

  if (!pool.text) return null

  // 注：早期版本在 root 节点上挂了 data-render-pool-size / data-rendered-length /
  // data-target-length 等 debug 属性。这些属性只在开发期自检渲染池进度用，
  // 生产环境属于 DOM 噪音且会被 React DevTools 标脏。已移除。
  return (
    <div className="contents">
      <MarkdownRenderer content={pool.text} isStreaming={true} />
    </div>
  )
})
