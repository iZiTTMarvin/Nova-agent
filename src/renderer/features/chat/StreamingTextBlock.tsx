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
  /**
   * 轮次是否仍在进行中（未触发 message_end）。
   *
   * 注意：这里的语义是「轮次未结束」，**不等于**「正在吐字」。等待 bash 权限 /
   * askQuestion 期间轮次仍在进行（isStreaming 为 true），只是没有新字符流入。
   * 之所以要区分，是因为它控制「是否做终态语法高亮」——只有轮次真正结束才
   * 触发一次性的逐行高亮，避免在权限弹窗这种中途暂停瞬间对整条长消息重新
   * 高亮（CodeBlock 每行炸出大量 token span，造成同步重排卡顿）。
   */
  isStreaming: boolean
  /**
   * 是否启用打字机放出节奏（仅对「当前仍在接收 delta 的最后一个 text 块」为 true）。
   *
   * 工具调用会在 blocks 序列中切开正文：已封口的历史 text 块若仍走打字机，
   * 会在工具卡片之间露出残片（如单独的「token 消费 SSE」、被截断的反引号「`方法」）。
   * 封口块应立刻展示全文，仅保留「流式中、无终态高亮」的渲染路径。
   */
  enableTypewriter?: boolean
  /**
   * 是否因等待用户输入（bash 权限 / askQuestion / 验证权限）而暂停。
   *
   * 暂停期间：停掉打字机 rAF（避免空转重渲染），直接显示已累积的全文，
   * 但仍按「流式中」渲染（纯文本、不做高亮），等轮次真正结束再统一高亮。
   */
  paused?: boolean
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
  enableTypewriter = true,
  paused = false,
  style = 'agile',
  onRenderPoolTick
}: StreamingTextBlockProps) {
  // 是否真正驱动打字机：轮次进行中、当前块仍接收 delta、且未暂停。
  // 暂停（等待权限）时关掉 rAF 循环，render pool 会直接把 renderedLength 拉到末尾，
  // pool.text === fullContent，即「显示全文但不再逐字动画」。
  const animating = isStreaming && enableTypewriter && !paused
  const pool = useStreamingRenderPool(fullContent, animating, style)
  const lastReportedLengthRef = useRef<number>(pool.renderedLength)

  // 每次 renderedLength 变化时通知外部（仅打字机驱动期间才有意义）
  useEffect(() => {
    if (!animating) return
    if (pool.renderedLength === lastReportedLengthRef.current) return
    lastReportedLengthRef.current = pool.renderedLength
    onRenderPoolTick?.()
  }, [pool.renderedLength, animating, onRenderPoolTick])

  // 轮次真正结束（message_end → isStreaming=false）：触发一次性终态高亮。
  // 这是唯一会走 CodeBlock 逐行 highlightLine 的路径。
  if (!isStreaming) {
    if (!fullContent) return null
    return <MarkdownRenderer content={fullContent} isStreaming={false} />
  }

  // 已封口块：轮次未结束但不再接收 delta，直接全文展示，避免工具间残片闪烁。
  const displayContent = animating ? pool.text : fullContent
  if (!displayContent) return null

  // 轮次进行中（含暂停等待权限）：始终按「流式中」渲染（纯文本、跳过高亮），
  // 避免暂停瞬间把整条消息的代码块重新逐行高亮，导致同步重排卡死。
  return (
    <div className="contents">
      <MarkdownRenderer content={displayContent} isStreaming={true} />
    </div>
  )
})
