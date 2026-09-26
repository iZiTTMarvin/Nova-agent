import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ExtendedMessage } from '../../stores/types'
import { TurnProcessTree } from '../chat/TurnProcessTree'
import { buildTurnRenderModel, resolveTurnPhase, type TurnBuildCache } from '../chat/turnProcessModel'
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getDistanceFromBottom,
  scrollContainerToBottom
} from '../chat/autoScroll'
import { ChevronIcon } from '../../components/Icons'

/**
 * 学习会话复用开发侧同一套回合渲染管线（TurnProcessTree → ProcessTraceList →
 * ToolCallGroup / ToolTraceRow / ThinkingBlock），不另建工具轨迹渲染器。
 */
const LEARN_MODE = 'learn' as const

interface LearningConversationProps {
  messages: readonly ExtendedMessage[]
  isGenerating: boolean
  currentGeneratingMessageId: string | null
  sessionId: string
  /** 阅读区滚动容器由父级拥有；本组件只请求滚动位置，不自建滚动区 */
  scrollContainerRef: RefObject<HTMLDivElement | null>
}

function messageText(message: ExtendedMessage): string {
  if (message.content) return message.content
  const parts: string[] = []
  for (const block of message.blocks ?? []) {
    if (block.type === 'text') parts.push(block.content)
  }
  return parts.join('\n')
}

function LearningAssistantMessage({
  message,
  sessionId,
  isGenerating,
  currentGeneratingMessageId
}: {
  message: ExtendedMessage
  sessionId: string
  isGenerating: boolean
  currentGeneratingMessageId: string | null
}): React.ReactElement {
  const hasBlocks = Boolean(message.blocks && message.blocks.length > 0)
  const turnPhase = resolveTurnPhase(message.id, currentGeneratingMessageId, isGenerating)
  const isCurrentAssistantGenerating = isGenerating && message.id === currentGeneratingMessageId

  // timeline 增量缓存：流式 tick 只浅拷贝尾部 blocks，前缀段引用稳定
  const turnBuildCacheRef = useRef<TurnBuildCache | undefined>(undefined)
  turnBuildCacheRef.current ??= {
    blocks: [], mode: LEARN_MODE, answerIndex: -1, lastSavePlanIndex: -1,
    timeline: [], segmentEndBlockIndex: []
  }

  const model = useMemo(
    () =>
      buildTurnRenderModel({
        blocks: hasBlocks ? message.blocks : undefined,
        toolCalls: message.toolCalls,
        mode: LEARN_MODE,
        phase: turnPhase,
        turnStartedAt: message.turnStartedAt,
        turnEndedAt: message.turnEndedAt,
        thinking: hasBlocks ? undefined : message.thinking || undefined,
        content: message.content || undefined,
        cache: turnBuildCacheRef.current
      }),
    [
      hasBlocks,
      message.blocks,
      message.toolCalls,
      message.turnStartedAt,
      message.turnEndedAt,
      message.thinking,
      message.content,
      turnPhase
    ]
  )

  return (
    <TurnProcessTree
      model={model}
      messageId={message.id}
      isLive={turnPhase === 'live'}
      interrupted={message.interrupted}
      isCurrentAssistantGenerating={isCurrentAssistantGenerating}
      isTurnActiveForThisMsg={isCurrentAssistantGenerating}
      isPausedForInput={false}
      blocks={message.blocks ?? []}
      sessionId={sessionId}
    />
  )
}

export function LearningConversation({
  messages,
  isGenerating,
  currentGeneratingMessageId,
  sessionId,
  scrollContainerRef
}: LearningConversationProps): React.ReactElement {
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const userScrolledUpRef = useRef(false)

  const contentRef = useRef<HTMLDivElement>(null)

  // 监听容器滚动：区分用户主动上滚与在底部跟随
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const distance = getDistanceFromBottom(el)
    const isUp = distance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX
    userScrolledUpRef.current = isUp
    setShowScrollBottom(isUp)
  }, [scrollContainerRef])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [scrollContainerRef, handleScroll])

  // 内容高度增量推进时（流式文字、块展开）：未上滚时自动贴底跟随
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (userScrolledUpRef.current) return
      const el = scrollContainerRef.current
      if (el) scrollContainerToBottom(el)
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [scrollContainerRef])

  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    userScrolledUpRef.current = false
    setShowScrollBottom(false)
    scrollContainerToBottom(el, 'smooth')
  }, [scrollContainerRef])

  if (messages.length === 0) {
    return (
      <div className="learning-conversation learning-conversation--empty">
        <div className="learning-conversation__empty-card">
          <h3>开始这段学习</h3>
          <p>
            直接说你想搞懂的问题，或者让教练从当前项目里挑一个最短的闭环起点。
            讲解会带着源码出处，回答不需要写代码。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="learning-conversation" ref={contentRef}>
      {messages.map(message => {
        if (message.role === 'user') {
          const text = messageText(message)
          if (!text.trim()) return null
          return (
            <div key={message.id} className="learning-msg learning-msg--user">
              <div className="learning-msg__bubble">{text}</div>
            </div>
          )
        }
        if (message.role !== 'assistant') return null
        return (
          <div key={message.id} className="learning-msg learning-msg--assistant">
            <LearningAssistantMessage
              message={message}
              sessionId={sessionId}
              isGenerating={isGenerating}
              currentGeneratingMessageId={currentGeneratingMessageId}
            />
            {message.interrupted && <div className="learning-msg__interrupted">本轮已取消</div>}
            {message.isError && <div className="learning-msg__interrupted">这段出错了，可以换个问法重试</div>}
          </div>
        )
      })}
      {isGenerating && (
        <div className="learning-conversation__generating" role="status">
          <span className="learning-conversation__generating-dot" aria-hidden="true" />
          教练正在整理与核对…
        </div>
      )}
      {showScrollBottom && (
        <button
          type="button"
          className="learning-scroll-bottom"
          aria-label="回到底部"
          onClick={scrollToBottom}
        >
          <ChevronIcon size={14} direction="down" />
        </button>
      )}
    </div>
  )
}
