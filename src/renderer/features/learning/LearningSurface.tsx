/**
 * 学习主区：对话滚动区 + 悬浮输入区，版式与开发模式同一套（chat-panel / chat-messages /
 * chat-panel__composer-area）。会话切换、投影刷新与草稿清理的生命周期受 E2E 保护，保持原语义。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { ChevronIcon } from '../../components/Icons'
import { useChatStore } from '../../stores/useChatStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { selectSessionIsRunning, useRunStore } from '../../stores/useRunStore'
import { isTerminalRunStatus } from '../../../shared/run/types'
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getDistanceFromBottom,
  isWithinUserScrollCooldown,
  markUserScrollInput,
  scrollContainerToBottom
} from '../chat/autoScroll'
import { useLearningStore } from './useLearningStore'
import { LearningConversation } from './LearningConversation'
import { LearningComposer } from './LearningComposer'
import { LearningEmptyState } from './LearningEmptyState'
import { VisualizationMessageContext } from '../visualization/VisualizationMessageContext'
import { InlineUiHostProvider } from '../inline-ui/InlineUiScope'
import { createLearningVisualizationSubmitter } from './learningVisualizationSubmitter'
import { firstOutlineTopic } from './outline/outlineOrder'
import { ChatContentWidthHandle } from '../chat/ChatContentWidthHandle'
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

const HISTORY_LOAD_SCROLL_THRESHOLD_PX = 80

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
  const hasMoreMessagesAbove = useChatStore(state => state.currentSessionId === sessionId && state.hasMoreMessagesAbove)
  const isLoadingOlderMessages = useChatStore(state => state.currentSessionId === sessionId && state.isLoadingOlderMessages)
  const loadOlderMessages = useChatStore(state => state.loadOlderMessages)
  const isGenerating = useRunStore(state => selectSessionIsRunning(state, sessionId))
  const isSessionLoading = useWorkspaceStore(state => state.isSessionLoading)

  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const scrollHeightBeforePrependRef = useRef<number | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const userScrolledUpRef = useRef(false)
  const userScrollCooldownUntilRef = useRef(0)
  const lastScrollTopRef = useRef(0)

  const hasMessages = messages.length > 0
  // 切会话水合期间消息尚未到达：显示加载态，不能误判为空会话而露出开场引导
  const showConversation = hasMessages && !isSessionLoading
  const isEmptyState = !hasMessages && !isSessionLoading

  // 滚动跟随状态属于单个会话；不重置会让新会话沿用上一会话的「已上滚」而停在顶部
  useEffect(() => {
    scrollHeightBeforePrependRef.current = null
    userScrolledUpRef.current = false
    userScrollCooldownUntilRef.current = 0
    lastScrollTopRef.current = 0
    setShowScrollToBottom(false)
  }, [sessionId])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const prevHeight = scrollHeightBeforePrependRef.current
    if (!container || prevHeight === null || isLoadingOlderMessages) return
    const delta = container.scrollHeight - prevHeight
    if (delta > 0) {
      container.scrollTop += delta
    }
    scrollHeightBeforePrependRef.current = null
  }, [messages, isLoadingOlderMessages])

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

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const scrolledUp = el.scrollTop < lastScrollTopRef.current - 1
    lastScrollTopRef.current = el.scrollTop
    const isUp = getDistanceFromBottom(el) > AUTO_SCROLL_BOTTOM_THRESHOLD_PX
    if (scrolledUp || isUp) {
      userScrolledUpRef.current = isUp || userScrolledUpRef.current
    } else if (!isWithinUserScrollCooldown(userScrollCooldownUntilRef.current)) {
      userScrolledUpRef.current = false
    }
    setShowScrollToBottom(isUp)
    if (hasMoreMessagesAbove && !isLoadingOlderMessages && el.scrollTop <= HISTORY_LOAD_SCROLL_THRESHOLD_PX) {
      scrollHeightBeforePrependRef.current = el.scrollHeight
      void loadOlderMessages()
    }
  }, [hasMoreMessagesAbove, isLoadingOlderMessages, loadOlderMessages])

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      markUserScrollInput(userScrollCooldownUntilRef)
      userScrolledUpRef.current = true
    }
  }, [])

  // 内容高度增量推进时（流式文字、题目行出现）：未上滚且不在用户滚轮冷却窗口内则自动贴底跟随
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (
        userScrolledUpRef.current ||
        isWithinUserScrollCooldown(userScrollCooldownUntilRef.current)
      ) {
        return
      }
      const el = scrollContainerRef.current
      if (el) scrollContainerToBottom(el)
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [showConversation])

  // 出题或收题时若用户在底部附近且未主动上滚，平滑跟随一次
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el || isWithinUserScrollCooldown(userScrollCooldownUntilRef.current)) return
    if (getDistanceFromBottom(el) <= 120) scrollContainerToBottom(el, 'smooth')
  }, [projection?.currentCheckpointId, projection?.questions.length])

  const handleScrollToBottomClick = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    userScrollCooldownUntilRef.current = 0
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
  const visualizationSubmitter = useMemo(() => createLearningVisualizationSubmitter(sessionId), [sessionId])
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
      {isSessionLoading ? (
        <div className="chat-session-loading" role="status" aria-live="polite">
          <div className="chat-session-loading__spinner" aria-hidden="true" />
          <span className="chat-session-loading__text">加载中...</span>
        </div>
      ) : showConversation && (
        <div
          className="chat-messages flex-1 overflow-y-auto"
          ref={scrollContainerRef}
          onScroll={handleScroll}
          onWheel={handleWheel}
          style={{ overflowAnchor: 'none' }}
        >
          {(isLoadingOlderMessages || hasMoreMessagesAbove) && (
            <div className="chat-messages__history-hint" aria-live="polite">
              {isLoadingOlderMessages ? '正在加载更早的消息…' : '向上滚动加载更早的消息'}
            </div>
          )}
          <div className="chat-messages__flow-inner" ref={contentRef} role="region" aria-label={LEARNING_MESSAGES_LABEL}>
            <VisualizationMessageContext.Provider value={visualizationSubmitter}>
              <InlineUiHostProvider value={true}>
                <LearningConversation
                  messages={messages}
                  isGenerating={isGenerating}
                  currentGeneratingMessageId={currentGeneratingMessageId}
                  sessionId={sessionId}
                  projection={projection}
                  actionsDisabled={busy}
                  onSendMessage={handleSuggestionMessage}
                />
              </InlineUiHostProvider>
            </VisualizationMessageContext.Provider>
          </div>
        </div>
      )}
      <div
        className={`chat-panel__composer-area ${isEmptyState ? 'chat-panel__composer-area--empty' : ''}`}
      >
        <div className="chat-panel__composer-inner">
          {showConversation && showScrollToBottom && (
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

      {/* 阅读区宽度手柄：与开发表面共用同一份宽度偏好 */}
      <ChatContentWidthHandle />
    </div>
  )
}
