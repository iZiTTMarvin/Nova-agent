/**
 * 学习主区：对话滚动区 + 悬浮输入区，版式与开发模式同一套（chat-panel / chat-messages /
 * chat-panel__composer-area）。会话切换、投影刷新与草稿清理的生命周期受 E2E 保护，保持原语义。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { ChevronIcon } from '../../components/Icons'
import { useChatStore } from '../../stores/useChatStore'
import { selectSessionIsRunning, useRunStore } from '../../stores/useRunStore'
import { isTerminalRunStatus } from '../../../shared/run/types'
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getDistanceFromBottom,
  scrollContainerToBottom
} from '../chat/autoScroll'
import { useLearningStore } from './useLearningStore'
import { LearningConversation } from './LearningConversation'
import { LearningComposer } from './LearningComposer'
import { LearningEmptyState } from './LearningEmptyState'
import { firstOutlineTopic } from './outline/outlineOrder'
import {
  LEARNING_CONVERSATION_LABEL,
  LEARNING_MESSAGES_LABEL,
  LEARNING_SCROLL_TO_BOTTOM,
  LEARNING_READ_FAILURE_TITLE,
  LEARNING_RETRY_LABEL,
  learningCommandRejectionCopy
} from './learningCopy'
import '../chat/composerShell.css'
import '../chat/ChatPanel.css'
import './LearningSurface.css'

export function LearningSurface({ sessionId }: { sessionId: string }): React.ReactElement {
  const projection = useLearningStore(state => (state.sessionId === sessionId ? state.projection : null))
  const status = useLearningStore(state => state.status)
  const commandPending = useLearningStore(state => state.sessionId === sessionId && state.commandPending)
  const commandError = useLearningStore(state => (state.sessionId === sessionId ? state.commandError : null))
  const refresh = useLearningStore(state => state.refresh)
  const sendCommand = useLearningStore(state => state.sendCommand)
  const clearForSession = useLearningStore(state => state.clearForSession)
  const currentGeneratingMessageId = useChatStore(state => state.currentGeneratingMessageId)
  const sessions = useChatStore(state => state.sessions)
  // 仅在 chat store 当前聚焦会话与本表面 sessionId 匹配时才渲染消息，杜绝跨会话切面水合间隙展示脏数据
  const messages = useChatStore(state => (state.currentSessionId === sessionId ? state.messages : []))
  const isGenerating = useRunStore(state => selectSessionIsRunning(state, sessionId))

  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const composerAreaRef = useRef<HTMLDivElement | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const userScrolledUpRef = useRef(false)

  useEffect(() => {
    const unsubChanged = window.api.on('learning:surface-changed', data => {
      const current = useLearningStore.getState().projection
      if (
        data.sessionId === sessionId ||
        (data.sessionId === null && data.workspaceRoot === current?.workspaceRoot)
      ) {
        void refresh(sessionId)
      }
    })
    const unsubSnapshot = window.api.on('run:snapshot', data => {
      if (data.snapshot.sessionId === sessionId && isTerminalRunStatus(data.snapshot.status)) void refresh(sessionId)
    })
    clearForSession(sessionId)
    void refresh(sessionId)
    return () => {
      unsubChanged()
      unsubSnapshot()
      clearForSession(null)
    }
  }, [sessionId, clearForSession, refresh])

  useEffect(() => {
    if (sessions.length > 0) useLearningStore.getState().pruneDrafts(sessions.map(session => session.id))
  }, [sessions])

  const hasMessages = messages.length > 0

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const isUp = getDistanceFromBottom(el) > AUTO_SCROLL_BOTTOM_THRESHOLD_PX
    userScrolledUpRef.current = isUp
    setShowScrollToBottom(isUp)
  }, [])

  // 内容高度增量推进时（流式文字、题目行出现）：未上滚则自动贴底跟随
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
  }, [hasMessages])

  // 悬浮输入区高度同步到滚动区 paddingBottom，消息流滚到底时刚好避让输入框
  useEffect(() => {
    const composerEl = composerAreaRef.current
    if (!composerEl || typeof ResizeObserver === 'undefined') return
    let rafId: number | null = null
    const update = (entries: ResizeObserverEntry[]) => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        for (const entry of entries) {
          const height = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height)
          if (height > 0 && scrollContainerRef.current) {
            scrollContainerRef.current.style.paddingBottom = `${height + 16}px`
          }
        }
      })
    }
    const observer = new ResizeObserver(update)
    observer.observe(composerEl)
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      observer.disconnect()
    }
  }, [])

  // 出题或收题时若用户在底部附近，平滑跟随一次
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    if (getDistanceFromBottom(el) <= 120) scrollContainerToBottom(el, 'smooth')
  }, [projection?.currentCheckpointId, projection?.questions.length])

  const handleScrollToBottomClick = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    userScrolledUpRef.current = false
    setShowScrollToBottom(false)
    scrollContainerToBottom(el, 'smooth')
  }, [])

  const handleSelectTopic = useCallback(
    (nodeId: string) => {
      void sendCommand({ sessionId, action: { type: 'select_node', nodeId } })
    },
    [sendCommand, sessionId]
  )

  const handleSuggestionMessage = useCallback(
    (text: string) => {
      void sendCommand({ sessionId, action: { type: 'message', text } })
    },
    [sendCommand, sessionId]
  )

  const busy = isGenerating || commandPending
  const isEmptyState = !hasMessages
  const firstTopic = useMemo(
    () => (projection && projection.tree.nodes.length > 0 ? firstOutlineTopic(projection.tree) : null),
    [projection]
  )

  const composer = (
    <LearningComposer
      sessionId={sessionId}
      projection={projection}
      isGenerating={isGenerating}
      disabled={busy}
    />
  )

  return (
    <div className="learning-surface chat-panel relative flex flex-col h-full" role="region" aria-label={LEARNING_CONVERSATION_LABEL}>
      {!isEmptyState && (
        <div
          className="chat-messages flex-1 overflow-y-auto"
          ref={scrollContainerRef}
          onScroll={handleScroll}
          style={{ overflowAnchor: 'none', paddingBottom: '156px' }}
        >
          <div className="chat-messages__flow-inner" ref={contentRef} role="region" aria-label={LEARNING_MESSAGES_LABEL}>
            <LearningConversation
              messages={messages}
              isGenerating={isGenerating}
              currentGeneratingMessageId={currentGeneratingMessageId}
              sessionId={sessionId}
              projection={projection}
            />
          </div>
        </div>
      )}
      <div
        ref={composerAreaRef}
        className={`chat-panel__composer-area ${isEmptyState ? 'chat-panel__composer-area--empty' : ''}`}
      >
        <div className="chat-panel__composer-inner">
          {!isEmptyState && showScrollToBottom && (
            <IconButton
              label={LEARNING_SCROLL_TO_BOTTOM}
              tooltip={LEARNING_SCROLL_TO_BOTTOM}
              icon={<ChevronIcon size={14} direction="down" />}
              variant="ghost"
              size="sm"
              className="chat-scroll-to-bottom"
              onClick={handleScrollToBottomClick}
            />
          )}
          {(status === 'error' || commandError) && (
            <div className="learning-banners w-full pointer-events-auto">
              {status === 'error' && (
                <Banner
                  status="error"
                  title={LEARNING_READ_FAILURE_TITLE}
                  endContent={
                    <Button
                      label={LEARNING_RETRY_LABEL}
                      variant="ghost"
                      size="sm"
                      onClick={() => void refresh(sessionId)}
                    />
                  }
                />
              )}
              {commandError && (
                <Banner
                  status={commandError.code === 'unavailable' ? 'error' : 'warning'}
                  title={learningCommandRejectionCopy(commandError)}
                />
              )}
            </div>
          )}
          <div className="w-full flex flex-col items-center pointer-events-none">
            {isEmptyState ? (
              <LearningEmptyState
                workspaceRoot={projection?.workspaceRoot ?? null}
                firstTopic={firstTopic}
                disabled={busy}
                onSelectTopic={handleSelectTopic}
                onSendMessage={handleSuggestionMessage}
              >
                {composer}
              </LearningEmptyState>
            ) : (
              composer
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
