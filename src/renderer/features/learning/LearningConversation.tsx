import { Fragment, useCallback, useMemo, useRef, useState } from 'react'
import { ChatMessage, ChatMessageBubble } from '@astryxdesign/core/Chat'
import { IconButton } from '@astryxdesign/core/IconButton'
import { CheckIcon, CopyIcon } from '../../components/Icons'
import type { ExtendedMessage } from '../../stores/types'
import type { LearningQuestionView, LearningSurfaceProjection } from '../../../shared/learning/surface'
import {
  LEARNING_CHECKPOINT_TOOL_NAME,
  parseCheckpointToolResult
} from '../../../shared/learning/checkpointToolResult'
import { TurnProcessTree } from '../chat/TurnProcessTree'
import { buildTurnRenderModel, resolveTurnPhase, type TurnBuildCache } from '../chat/turnProcessModel'
import { AssistantPendingIndicator } from '../chat/AssistantPendingIndicator'
import { LearningQuestionRow } from './LearningQuestionRow'
import {
  LEARNING_COPY_MESSAGE,
  LEARNING_MESSAGE_COPIED,
  LEARNING_TURN_ERROR,
  LEARNING_TURN_INTERRUPTED,
  learningTopicDivider
} from './learningCopy'

/**
 * 学习会话复用开发侧同一套回合渲染管线（TurnProcessTree → ProcessTraceList →
 * ToolCallGroup / ToolTraceRow / ThinkingBlock），不另建工具轨迹渲染器。
 * 题目行锚定在产生它的回复之后；找不到锚点的题渲染在对话末尾。
 */
const LEARN_MODE = 'learn' as const

interface LearningConversationProps {
  messages: readonly ExtendedMessage[]
  isGenerating: boolean
  currentGeneratingMessageId: string | null
  sessionId: string
  projection: LearningSurfaceProjection | null
}

function messageText(message: ExtendedMessage): string {
  if (message.content) return message.content
  const parts: string[] = []
  for (const block of message.blocks ?? []) {
    if (block.type === 'text') parts.push(block.content)
  }
  return parts.join('\n')
}

/** 分隔线标题：展示文本形如「开始学习「X」」，取引号内主题名并与树中节点核对；取不到用消息文本。 */
function topicDividerLabel(text: string, projection: LearningSurfaceProjection | null): string {
  const trimmed = text.trim()
  const match = /^开始学习「(.+)」$/u.exec(trimmed)
  const title = match?.[1]?.trim()
  if (!title) return trimmed
  const canonical = projection?.tree.nodes.find(node => node.title === title)?.title ?? title
  return learningTopicDivider(canonical)
}

function CopyMessageButton({ message }: { message: ExtendedMessage }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    const text = message.content || messageText(message)
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    }, () => {})
  }, [message])
  return (
    <IconButton
      label={copied ? LEARNING_MESSAGE_COPIED : LEARNING_COPY_MESSAGE}
      icon={copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      tooltip={LEARNING_COPY_MESSAGE}
    />
  )
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
  projection
}: LearningConversationProps): React.ReactElement {
  const topicStartIds = useMemo(
    () => new Set(projection?.topicStartMessageIds ?? []),
    [projection?.topicStartMessageIds]
  )
  const questions = projection?.questions

  // 题目行锚定：从助手消息的 learning_checkpoint 工具块取 checkpointId
  const { rowsByMessageId, tailRows } = useMemo(() => {
    const visible = (questions ?? []).filter(question => question.state !== 'awaiting_answer')
    const anchorOf = new Map<string, string>()
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (const block of message.blocks ?? []) {
        if (block.type !== 'tool' || block.toolName !== LEARNING_CHECKPOINT_TOOL_NAME) continue
        const parsed = parseCheckpointToolResult(block.result)
        if (parsed && !anchorOf.has(parsed.checkpointId)) anchorOf.set(parsed.checkpointId, message.id)
      }
    }
    const byMessage = new Map<string, LearningQuestionView[]>()
    const tail: LearningQuestionView[] = []
    for (const question of visible) {
      const messageId = anchorOf.get(question.checkpointId)
      if (messageId) {
        byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), question])
      } else {
        tail.push(question)
      }
    }
    return { rowsByMessageId: byMessage, tailRows: tail }
  }, [messages, questions])

  const currentGeneratingTurnStartedAt = useMemo(() => {
    if (!currentGeneratingMessageId) return undefined
    const generating = messages.find(message => message.id === currentGeneratingMessageId)
    return generating?.turnStartedAt ?? generating?.timestamp
  }, [messages, currentGeneratingMessageId])

  return (
    <>
      {messages.map(message => {
        if (message.role === 'user') {
          const text = messageText(message)
          if (!text.trim()) return null
          if (topicStartIds.has(message.id)) {
            return (
              <div key={message.id} className="learning-topic-divider">
                <span className="learning-topic-divider__label">{topicDividerLabel(text, projection)}</span>
              </div>
            )
          }
          return (
            <ChatMessage key={message.id} sender="user">
              <ChatMessageBubble variant="filled" className="chat-msg chat-msg--user">
                {text}
              </ChatMessageBubble>
            </ChatMessage>
          )
        }
        if (message.role !== 'assistant') return null
        const rows = rowsByMessageId.get(message.id) ?? []
        return (
          <Fragment key={message.id}>
            <ChatMessage sender="assistant">
              <div className="chat-msg chat-msg--assistant">
                {!isGenerating && (
                  <div className="chat-msg__actions">
                    <CopyMessageButton message={message} />
                  </div>
                )}
                <LearningAssistantMessage
                  message={message}
                  sessionId={sessionId}
                  isGenerating={isGenerating}
                  currentGeneratingMessageId={currentGeneratingMessageId}
                />
                {message.interrupted && <div className="learning-msg__state">{LEARNING_TURN_INTERRUPTED}</div>}
                {message.isError && (
                  <div className="learning-msg__state learning-msg__state--error">{LEARNING_TURN_ERROR}</div>
                )}
              </div>
            </ChatMessage>
            {rows.map(question => (
              <LearningQuestionRow key={question.checkpointId} sessionId={sessionId} question={question} />
            ))}
          </Fragment>
        )
      })}
      {tailRows.map(question => (
        <LearningQuestionRow key={question.checkpointId} sessionId={sessionId} question={question} />
      ))}
      {isGenerating && (
        <div className="chat-messages__tail-status">
          <AssistantPendingIndicator turnStartedAt={currentGeneratingTurnStartedAt} />
        </div>
      )}
    </>
  )
}
