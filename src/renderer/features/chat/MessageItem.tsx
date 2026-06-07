/**
 * MessageItem — 单条消息渲染组件
 *
 * 从 ChatPanel.tsx 的 messages.map 内联中抽出，配合 _revision 实现精细 memo：
 * - 只有 _revision 变化的当前流式消息才真正重渲染
 * - 历史消息在 React.memo(areEqual) 中直接跳过 reconciliation
 */
import React from 'react'
import { ThinkingBlock } from './ThinkingBlock'
import { StreamingTextBlock } from './StreamingTextBlock'
import { DiffViewer } from '../diff/DiffViewer'
import { isActiveThinkingBlock, shouldRenderToolBlock } from './renderingPolicy'
import { StreamingFileCard } from './StreamingFileCard'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ToolBox } from './ToolBox'
import { AssistantPendingIndicator } from './AssistantPendingIndicator'
import { UndoIcon } from '../../components/Icons'
import type { Mode } from '../../../shared/session/types'
import type { ExtendedMessage, ExtendedToolCall, RendererMessageBlock, MessageDiffCache } from '../../stores/types'
import type { DiffEntry } from '../../../shared/diff/types'

export interface MessageItemProps {
  msg: ExtendedMessage
  isGenerating: boolean
  currentGeneratingMessageId: string | null
  currentMode: Mode
  currentSessionId: string | null
  onRollback: (messageId: string) => void
  onAcceptFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>
  onRejectFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>
  onRenderPoolTick: () => void
  diffCache?: MessageDiffCache
  isDiffLoading: boolean
  diffPlaceholders?: Array<{ filePath: string; status: DiffEntry['status'] }>
}

// ── 模块级辅助函数（从 ChatPanel.tsx 搬入） ──────────────────────

function hasVisibleToolCalls(toolCalls: ExtendedToolCall[] | undefined, mode: Mode): boolean {
  return !!toolCalls?.some(toolCall => shouldRenderToolBlock(mode, toolCall.name))
}

function hasVisibleBlocks(blocks: RendererMessageBlock[] | undefined, mode: Mode): boolean {
  return !!blocks?.some(block => {
    if (block.type === 'thinking' || block.type === 'text') {
      return block.content.trim().length > 0
    }
    if (block.type === 'image') {
      return true
    }
    return shouldRenderToolBlock(mode, block.toolName)
  })
}

type ThinkingParseSource = Pick<ExtendedMessage, 'id'> & {
  thinking?: string
  content: string
}

function parseThinking(msg: ThinkingParseSource, isGenerating: boolean, currentGeneratingMessageId: string | null) {
  let thinkingContent = msg.thinking || ''
  let textContent = msg.content || ''
  let isThinkingActive = false

  if (msg.thinking !== undefined && msg.thinking !== '') {
    isThinkingActive = isGenerating && msg.id === currentGeneratingMessageId && !msg.content
    return { thinkingContent, textContent, isThinkingActive }
  }

  if (msg.content && msg.content.includes('<think>')) {
    const thinkStartIndex = msg.content.indexOf('<think>')
    const thinkEndIndex = msg.content.indexOf('</think>')

    if (thinkEndIndex !== -1) {
      thinkingContent = msg.content.substring(thinkStartIndex + 7, thinkEndIndex)
      textContent = msg.content.substring(0, thinkStartIndex) + msg.content.substring(thinkEndIndex + 8)
      isThinkingActive = false
    } else {
      thinkingContent = msg.content.substring(thinkStartIndex + 7)
      textContent = msg.content.substring(0, thinkStartIndex)
      isThinkingActive = isGenerating && msg.id === currentGeneratingMessageId
    }
  }

  return { thinkingContent, textContent, isThinkingActive }
}

// ── 组件主体 ─────────────────────────────────────────────────

function MessageItemInner({
  msg,
  isGenerating,
  currentGeneratingMessageId,
  currentMode,
  currentSessionId,
  onRollback,
  onAcceptFile,
  onRejectFile,
  onRenderPoolTick,
  diffCache,
  isDiffLoading,
  diffPlaceholders
}: MessageItemProps) {
  const isAssistant = msg.role === 'assistant'
  const isUser = msg.role === 'user'

  // blocks 渲染路径：按流式事件顺序展示 thinking → text → tool → text → ...
  const hasBlocks = isAssistant && msg.blocks && msg.blocks.length > 0

  // 旧路径兼容：无 blocks 时走 parseThinking 正则兜底
  const { thinkingContent, textContent, isThinkingActive } = isAssistant && !hasBlocks
    ? parseThinking(msg, isGenerating, currentGeneratingMessageId)
    : { thinkingContent: '', textContent: msg.content, isThinkingActive: false }
  const isCurrentAssistantGenerating = isAssistant && isGenerating && msg.id === currentGeneratingMessageId
  const hasVisibleContent = hasBlocks
    ? hasVisibleBlocks(msg.blocks, currentMode)
    : !!thinkingContent.trim() || !!textContent.trim() || hasVisibleToolCalls(msg.toolCalls, currentMode)
  const shouldShowPending = isCurrentAssistantGenerating && !hasVisibleContent

  // 用户消息图片提取（用于图片网格渲染）
  const userImageBlocks = isUser
    ? msg.blocks?.filter((b): b is { type: 'image'; fileName: string; dataUrl: string; mimeType: string } => b.type === 'image') ?? []
    : []

  return (
    <div
      className={`chat-msg-wrapper chat-msg-wrapper--${msg.role === 'user' ? 'user' : 'assistant'}`}
    >
      <div className={`chat-msg chat-msg--${msg.role === 'user' ? 'user' : 'assistant'} ${msg.isError ? 'chat-msg--error' : ''}`}>
        {/* 悬浮操作栏：仅在 assistant 消息上显示，且必须是生成完毕状态 */}
        {isAssistant && !isGenerating && (
          <div className="chat-msg__actions">
            <button
              className="chat-msg__action-btn"
              onClick={() => onRollback(msg.id)}
              title="回退到此消息之前的状态"
            >
              <UndoIcon size={13} />
            </button>
          </div>
        )}

        {shouldShowPending && <AssistantPendingIndicator />}

        {hasBlocks ? (
          /* blocks 顺序渲染：按真实流式事件顺序展示 */
          msg.blocks!.map((block, idx) => {
            switch (block.type) {
              case 'thinking':
                return (
                  <ThinkingBlock
                    key={idx}
                    thinking={block.content}
                    active={isActiveThinkingBlock(
                      msg.blocks!,
                      idx,
                      isGenerating,
                      msg.id,
                      currentGeneratingMessageId
                    )}
                  />
                )
              case 'text':
                return (
                  <StreamingTextBlock
                    key={`${idx}-${msg.id}`}
                    fullContent={block.content}
                    isStreaming={isCurrentAssistantGenerating}
                    onRenderPoolTick={onRenderPoolTick}
                  />
                )
              case 'image':
                return null
              case 'tool': {
                if (!shouldRenderToolBlock(currentMode, block.toolName)) {
                  return null
                }
                if (block.toolName === 'write' || block.toolName === 'edit') {
                  return (
                    <StreamingFileCard
                      key={block.toolCallId}
                      toolCallId={block.toolCallId}
                      toolName={block.toolName}
                      status={block.status}
                      argumentsRaw={block.argumentsRaw}
                      args={block.arguments}
                      result={block.result}
                    />
                  )
                }
                return <ToolBox key={block.toolCallId} name={block.toolName} args={block.arguments} status={block.status} result={block.result} />
              }
            }
          })
        ) : (
          /* 旧渲染路径：无 blocks 时走分桶逻辑 */
          <>
            {thinkingContent && (
              <ThinkingBlock thinking={thinkingContent} active={isThinkingActive} />
            )}
            {textContent && <MarkdownRenderer content={textContent} isStreaming={isCurrentAssistantGenerating} />}
            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <div style={{ marginTop: '12px' }}>
                {msg.toolCalls.map(tc => {
                  if (!shouldRenderToolBlock(currentMode, tc.name)) return null
                  if (tc.name === 'write' || tc.name === 'edit') {
                    return (
                      <StreamingFileCard
                        key={tc.id}
                        toolCallId={tc.id}
                        toolName={tc.name}
                        status={tc.status}
                        argumentsRaw={tc.argumentsRaw}
                        args={tc.arguments}
                        result={tc.result}
                      />
                    )
                  }
                  return <ToolBox key={tc.id} name={tc.name} args={tc.arguments} status={tc.status} result={tc.result} />
                })}
              </div>
            )}
          </>
        )}

        {/* 用户消息图片网格 */}
        {isUser && userImageBlocks.length > 0 && (
          <div className="user-message-image-grid">
            {userImageBlocks.map((img, idx) => (
              <button
                key={`${img.fileName}-${idx}`}
                className="user-message-image-grid__item"
                type="button"
                title={img.fileName}
              >
                <img src={img.dataUrl} alt={img.fileName} draggable={false} />
              </button>
            ))}
          </div>
        )}

        {/* diff 区域：loading 时优先展示骨架 */}
        {isAssistant && currentSessionId && isDiffLoading && (
          <DiffViewer
            diffs={[]}
            reviews={{}}
            sessionId={currentSessionId}
            messageId={msg.id}
            isLoading={true}
            loadingPlaceholders={diffPlaceholders}
          />
        )}

        {/* diff 最终数据 */}
        {isAssistant && currentSessionId && !isDiffLoading && diffCache && diffCache.diffs.length > 0 && (
          <DiffViewer
            diffs={diffCache.diffs}
            reviews={diffCache.reviews}
            sessionId={currentSessionId}
            messageId={msg.id}
            onRejectFile={(filePath) => onRejectFile(currentSessionId, msg.id, filePath)}
            onAcceptFile={(filePath) => onAcceptFile(currentSessionId, msg.id, filePath)}
          />
        )}

        {/* 验证结果摘要 */}
        {isAssistant && msg.verificationSummary && (
          <div className={`verification-summary ${msg.verificationSummary.startsWith('\u2717') ? 'verification-summary--failed' : 'verification-summary--passed'}`}>
            <pre className="verification-summary__content">{msg.verificationSummary}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

// ── 自定义比较：只比 primitive / reference ──────────────────

export function areEqual(prev: MessageItemProps, next: MessageItemProps): boolean {
  return (
    prev.msg.id === next.msg.id &&
    prev.msg._revision === next.msg._revision &&
    prev.isGenerating === next.isGenerating &&
    prev.currentGeneratingMessageId === next.currentGeneratingMessageId &&
    prev.currentMode === next.currentMode &&
    prev.currentSessionId === next.currentSessionId &&
    prev.onRollback === next.onRollback &&
    prev.onAcceptFile === next.onAcceptFile &&
    prev.onRejectFile === next.onRejectFile &&
    prev.onRenderPoolTick === next.onRenderPoolTick &&
    prev.diffCache === next.diffCache &&
    prev.isDiffLoading === next.isDiffLoading &&
    prev.diffPlaceholders === next.diffPlaceholders
  )
}

export const MessageItem = React.memo(MessageItemInner, areEqual)
