/**
 * StreamingTextBlock — 流式期间的文本块渲染
 *
 * 封装 useStreamingRenderPool + MarkdownRenderer（两阶段增量）：
 * - 流式期间用 render pool 逐步放出字符（打字机效果）
 * - Markdown 侧：已封口 prefix 冻结 + 活动 tail 低成本重解析
 * - tab 不可见时降频放出；回前台一次合并到最新长度
 * - 流式结束后直接显示完整内容并启用终态高亮
 */
import React, { useEffect, useRef, useState } from 'react'
import { useStreamingRenderPool, type RenderStyle } from '../../hooks/useStreamingRenderPool'
import { MarkdownRenderer } from './MarkdownRenderer'

export interface StreamingTextBlockProps {
  /** 上游完整文本（来自 store 的 message block.content） */
  fullContent: string
  /**
   * 轮次是否仍在进行中（未触发 message_end）。
   *
   * 注意：这里的语义是「轮次未结束」，**不等于**「正在吐字」。等待 bash 权限 /
   * askQuestion 期间轮次仍在进行（isStreaming 为 true），只是没有新字符流入。
   */
  isStreaming: boolean
  /**
   * 是否启用打字机放出节奏（仅对「当前仍在接收 delta 的最后一个 text 块」为 true）。
   */
  enableTypewriter?: boolean
  /**
   * 是否因等待用户输入（bash 权限 / askQuestion / 验证权限）而暂停。
   */
  paused?: boolean
  /** 渲染风格：agile (32ms 帧) | elegant (36ms 帧) */
  style?: RenderStyle
  /**
   * render pool 每次 tick（renderedLength 变化）时的回调。
   */
  onRenderPoolTick?: () => void
}

/**
 * 文档可见性：隐藏时暂停打字机 rAF；重新可见时一次合并到最新全文长度。
 */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
  )
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onChange = (): void => {
      setVisible(document.visibilityState !== 'hidden')
    }
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

/**
 * 流式文本块。流式期间走 useStreamingRenderPool 控制放出节奏，
 * Markdown 走 sealed+tail 增量解析；结束后一次性终态高亮。
 */
export const StreamingTextBlock = React.memo(function StreamingTextBlock({
  fullContent,
  isStreaming,
  enableTypewriter = true,
  paused = false,
  style = 'agile',
  onRenderPoolTick
}: StreamingTextBlockProps) {
  const docVisible = useDocumentVisible()

  // 不可见或暂停时关掉打字机：render pool 会把 renderedLength 拉到末尾（一次合并）
  const animating = isStreaming && enableTypewriter && !paused && docVisible
  const pool = useStreamingRenderPool(fullContent, animating, style)
  const lastReportedLengthRef = useRef<number>(pool.renderedLength)

  useEffect(() => {
    if (!animating) return
    if (pool.renderedLength === lastReportedLengthRef.current) return
    lastReportedLengthRef.current = pool.renderedLength
    onRenderPoolTick?.()
  }, [pool.renderedLength, animating, onRenderPoolTick])

  // 轮次真正结束：终态高亮（唯一走完整 highlightLine 的路径）
  if (!isStreaming) {
    if (!fullContent) return null
    return <MarkdownRenderer content={fullContent} isStreaming={false} />
  }

  // 已封口块 / 暂停 / 后台 tab：直接全文展示，仍按流式路径（增量 + 无终态高亮）
  const displayContent = animating ? pool.text : fullContent
  if (!displayContent) return null

  return (
    <div className="contents">
      <MarkdownRenderer content={displayContent} isStreaming={true} />
    </div>
  )
})
