/**
 * MessageItem — 单条消息渲染组件
 *
 * 从 ChatPanel.tsx 的 messages.map 内联中抽出，配合 _revision 实现精细 memo：
 * - 只有 _revision 变化的当前流式消息才真正重渲染
 * - 历史消息在 React.memo(areEqual) 中直接跳过 reconciliation
 */
import React, { useEffect, useState } from 'react'
import { ThinkingBlock } from './ThinkingBlock'
import { StreamingTextBlock } from './StreamingTextBlock'
import { DiffViewer } from '../diff/DiffViewer'
import { isActiveThinkingBlock, shouldRenderToolBlock } from './renderingPolicy'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ToolCallGroup } from './ToolCallGroup'
import { buildBlockRenderUnits, buildToolCallRenderUnits } from './toolCallGrouping'
import { shouldEnableTextBlockTypewriter } from './textBlockTypewriterPolicy'
import { renderToolBlock } from './renderToolBlock'
import { AssistantPendingIndicator } from './AssistantPendingIndicator'
import { RegenerateIcon, EditIcon } from '../../components/Icons'
import type { Mode } from '../../../shared/session/types'
import type { ExtendedMessage, ExtendedToolCall, RendererMessageBlock, MessageDiffCache } from '../../stores/types'
import type { DiffEntry } from '../../../shared/diff/types'
import type { MessageRenderMode } from './messageRenderTier'

export interface MessageItemProps {
  msg: ExtendedMessage
  /**
   * 列表尾部分层：static 消息关闭流式动画与工具卡入场，减轻长会话 DOM 压力。
   * 默认 live，由 ChatPanel 按行下标计算。
   */
  renderMode?: MessageRenderMode
  isGenerating: boolean
  /**
   * 是否因等待用户输入（askQuestion / bash 权限 / 验证权限）而暂停。
   *
   * 暂停期间 message_end 不会触发，isGenerating 仍为 true（轮次未结束、composer 仍显运行态、
   * 不显示回退按钮），但实际上没有任何内容在流式输出。此时必须停掉流式动画
   * （ThinkingBlock 100ms 计时器 + useStreamingRenderPool 的 rAF 循环），
   * 否则它们会在用户决策前持续空转重渲染，导致 UI 卡顿。
   */
  isPausedForInput?: boolean
  currentGeneratingMessageId: string | null
  currentMode: Mode
  currentSessionId: string | null
  /** Tier 1：工作区未重放此分支文件改动，diff 仅作历史展示 */
  tier1DiffStale?: boolean
  onRegenerate: (messageId: string) => void
  /** 该消息操作失败时的错误提示；存在时操作按钮应置灰并展示 Tooltip */
  rollbackError?: string
  /** 含图等暂不支持 regenerate 时禁用重生成按钮 */
  regenerateBlocked?: boolean
  /** 切换到兄弟分支（翻页器） */
  onSwitchBranch?: (targetMessageId: string) => void
  /** 编辑用户消息并重发：分叉出新分支（保留旧分支），随后流式生成新回答 */
  onEditResend?: (messageId: string, newContent: string) => void
  onAcceptFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>
  onRejectFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>
  /** PRD §5.3：批量接受 */
  onAcceptAllFiles?: (sessionId: string, messageId: string, filePaths: string[]) => Promise<void>
  /** PRD §5.3：批量拒绝，返回恢复成功与失败的文件 */
  onRejectAllFiles?: (sessionId: string, messageId: string, filePaths: string[]) => Promise<{ restored: string[]; failed: Array<{ filePath: string; error: string }> }>
  onRenderPoolTick: () => void
  diffCache?: MessageDiffCache
  isDiffLoading: boolean
  diffPlaceholders?: Array<{ filePath: string; status: DiffEntry['status'] }>
  /** T06：按需加载 diff 的回调，MessageItem 挂载时调用 */
  onLoadDiffs?: (sessionId: string, messageId: string) => void
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
  renderMode = 'live',
  isGenerating,
  isPausedForInput = false,
  currentGeneratingMessageId,
  currentMode,
  currentSessionId,
  onRegenerate,
  regenerateBlocked = false,
  tier1DiffStale = false,
  rollbackError,
  onSwitchBranch,
  onEditResend,
  onAcceptFile,
  onRejectFile,
  onAcceptAllFiles,
  onRejectAllFiles,
  onRenderPoolTick,
  diffCache,
  isDiffLoading,
  diffPlaceholders,
  onLoadDiffs
}: MessageItemProps) {
  const isAssistant = msg.role === 'assistant'
  const isUser = msg.role === 'user'
  const isStaticRow = renderMode === 'static'

  // 用户消息编辑态（编辑重发）：本地受控，确认后调用 onEditResend 走分叉重发
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState('')

  // 流式动画的有效开关：轮次进行中且未因等待用户输入而暂停；static 行强制关闭。
  const streamingActive = isGenerating && !isPausedForInput && !isStaticRow

  // T06：assistant 消息挂载时按需加载 diff 数据（替代 selectSession 全量预加载）
  useEffect(() => {
    if (isAssistant && currentSessionId && onLoadDiffs && !diffCache && !isDiffLoading) {
      onLoadDiffs(currentSessionId, msg.id)
    }
  }, [msg.id, isAssistant, currentSessionId, onLoadDiffs, diffCache, isDiffLoading])

  // blocks 渲染路径：按流式事件顺序展示 thinking → text → tool → text → ...
  const hasBlocks = isAssistant && msg.blocks && msg.blocks.length > 0

  // 旧路径兼容：无 blocks 时走 parseThinking 正则兜底
  const { thinkingContent, textContent, isThinkingActive } = isAssistant && !hasBlocks
    ? parseThinking(msg, streamingActive, currentGeneratingMessageId)
    : { thinkingContent: '', textContent: msg.content, isThinkingActive: false }
  const isCurrentAssistantGenerating = isAssistant && streamingActive && msg.id === currentGeneratingMessageId
  // 「轮次是否进行中」：与 streamingActive 不同，它**不**受 isPausedForInput 影响。
  // 专门用于控制 StreamingTextBlock 的终态高亮时机——等待 bash 权限 / askQuestion
  // 期间轮次仍在进行，此时若把 isStreaming 打成 false，会触发整条消息代码块的逐行
  // 高亮（每行炸出大量 token span），在权限弹窗瞬间造成同步重排卡死。
  const isTurnActiveForThisMsg =
    isAssistant && isGenerating && msg.id === currentGeneratingMessageId && !isStaticRow
  const hasVisibleContent = hasBlocks
    ? hasVisibleBlocks(msg.blocks, currentMode)
    : !!thinkingContent.trim() || !!textContent.trim() || hasVisibleToolCalls(msg.toolCalls, currentMode)
  const shouldShowPending = isCurrentAssistantGenerating && !hasVisibleContent
  const handleRenderPoolTick = isStaticRow ? undefined : onRenderPoolTick

  // 用户消息图片提取（用于图片网格渲染）
  const userImageBlocks = isUser
    ? msg.blocks?.filter((b): b is { type: 'image'; fileName: string; dataUrl: string; mimeType: string } => b.type === 'image') ?? []
    : []

  return (
    <div
      className={`chat-msg-wrapper chat-msg-wrapper--${msg.role === 'user' ? 'user' : 'assistant'}`}
    >
      <div className={`chat-msg chat-msg--${msg.role === 'user' ? 'user' : 'assistant'} ${msg.isError ? 'chat-msg--error' : ''}`}>
        {/* 悬浮操作栏：须在 static-body 之外，避免 content-visibility 的 contain:paint 裁切 top:-12px 溢出 */}
        {isAssistant && !isGenerating && (
          <div className="chat-msg__actions">
            <button
              className={`chat-msg__action-btn${rollbackError || regenerateBlocked ? ' chat-msg__action-btn--disabled' : ''}`}
              onClick={() => onRegenerate(msg.id)}
              disabled={!!rollbackError || regenerateBlocked}
              title={
                rollbackError
                  ? `无法重新生成：${rollbackError}`
                  : regenerateBlocked
                    ? '重新生成暂不支持含图片的消息'
                    : '重新生成此回答（保留原分支）'
              }
            >
              <RegenerateIcon size={13} />
            </button>
          </div>
        )}

        {/* 兄弟分支翻页器：‹ k/n › */}
        {msg.branch && msg.branch.total > 1 && onSwitchBranch && !isGenerating && (
          <div className="chat-msg__branch-flipper">
            <button
              type="button"
              className="chat-msg__branch-btn"
              disabled={msg.branch.index <= 1 || !!rollbackError}
              onClick={() => onSwitchBranch(msg.branch!.siblingIds[msg.branch!.index - 2]!)}
              title="上一条分支"
              aria-label="上一条分支"
            >
              ‹
            </button>
            <span className="chat-msg__branch-label">
              {msg.branch.index} / {msg.branch.total}
            </span>
            <button
              type="button"
              className="chat-msg__branch-btn"
              disabled={msg.branch.index >= msg.branch.total || !!rollbackError}
              onClick={() => onSwitchBranch(msg.branch!.siblingIds[msg.branch!.index]!)}
              title="下一条分支"
              aria-label="下一条分支"
            >
              ›
            </button>
          </div>
        )}

        {/* 用户消息编辑入口：仅纯文本消息可编辑重发（含图片的消息本期不支持，避免重发丢图） */}
        {isUser && !isGenerating && !isEditing && onEditResend && userImageBlocks.length === 0 && (
          <div className="chat-msg__actions">
            <button
              className={`chat-msg__action-btn${rollbackError ? ' chat-msg__action-btn--disabled' : ''}`}
              onClick={() => {
                setEditText(typeof textContent === 'string' ? textContent : '')
                setIsEditing(true)
              }}
              disabled={!!rollbackError}
              title={rollbackError ? `无法编辑：${rollbackError}` : '编辑并重发（保留原分支）'}
            >
              <EditIcon size={13} />
            </button>
          </div>
        )}

        <div className={isStaticRow ? 'chat-msg__static-body' : undefined}>
        {shouldShowPending && <AssistantPendingIndicator />}

        {hasBlocks ? (
          /* blocks 顺序渲染：分组后的 tool 单元 + 原始 thinking/text */
          buildBlockRenderUnits(msg.blocks, currentMode).map((unit) => {
            if (unit.kind === 'block') {
              const { block, index } = unit
              switch (block.type) {
                case 'thinking':
                  return (
                    <ThinkingBlock
                      key={`thinking-${index}`}
                      thinking={block.content}
                      active={isActiveThinkingBlock(
                        msg.blocks!,
                        index,
                        streamingActive,
                        msg.id,
                        currentGeneratingMessageId
                      )}
                    />
                  )
                case 'text':
                  return (
                    <StreamingTextBlock
                      key={`text-${index}-${msg.id}`}
                      fullContent={block.content}
                      isStreaming={isTurnActiveForThisMsg}
                      enableTypewriter={shouldEnableTextBlockTypewriter({
                        isTurnActive: isTurnActiveForThisMsg,
                        blockIndex: index,
                        blocks: msg.blocks
                      })}
                      paused={isPausedForInput}
                      onRenderPoolTick={handleRenderPoolTick}
                    />
                  )
                case 'image':
                  return null
                default:
                  return null
              }
            }

            if (unit.kind === 'toolGroup') {
              const groupKey = unit.blocks.map(b => b.toolCallId).join('-')
              return (
                <ToolCallGroup
                  key={`group-${groupKey}`}
                  toolName={unit.toolName}
                  blocks={unit.blocks}
                />
              )
            }

            if (unit.kind === 'tool') {
              return renderToolBlock(unit.block, isCurrentAssistantGenerating)
            }

            return null
          })
        ) : (
          /* 旧渲染路径：无 blocks 时走分桶逻辑 */
          <>
            {thinkingContent && (
              <ThinkingBlock thinking={thinkingContent} active={isThinkingActive} />
            )}
            {textContent && !(isUser && isEditing) && <MarkdownRenderer content={textContent} isStreaming={isTurnActiveForThisMsg} />}
            {isUser && isEditing && (
              <div className="chat-msg__edit">
                <textarea
                  className="chat-msg__edit-input"
                  value={editText}
                  onChange={e => setEditText(e.target.value)}
                  autoFocus
                  rows={Math.min(10, Math.max(2, editText.split('\n').length))}
                  onKeyDown={e => {
                    // Esc 取消；Ctrl/⌘+Enter 确认重发
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setIsEditing(false)
                    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault()
                      const t = editText.trim()
                      if (t) {
                        setIsEditing(false)
                        onEditResend?.(msg.id, t)
                      }
                    }
                  }}
                />
                <div className="chat-msg__edit-actions">
                  <button
                    className="chat-msg__edit-btn chat-msg__edit-btn--cancel"
                    onClick={() => setIsEditing(false)}
                  >
                    取消
                  </button>
                  <button
                    className="chat-msg__edit-btn chat-msg__edit-btn--confirm"
                    disabled={!editText.trim()}
                    onClick={() => {
                      const t = editText.trim()
                      if (t) {
                        setIsEditing(false)
                        onEditResend?.(msg.id, t)
                      }
                    }}
                  >
                    重发
                  </button>
                </div>
              </div>
            )}
            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <div style={{ marginTop: '12px' }}>
                {buildToolCallRenderUnits(msg.toolCalls, currentMode).map((unit) => {
                  if (unit.kind === 'toolGroup') {
                    const groupKey = unit.blocks.map(b => b.toolCallId).join('-')
                    return (
                      <ToolCallGroup
                        key={`group-${groupKey}`}
                        toolName={unit.toolName}
                        blocks={unit.blocks}
                      />
                    )
                  }
                  if (unit.kind === 'tool') {
                    return renderToolBlock(unit.block, isCurrentAssistantGenerating)
                  }
                  return null
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
            tier1Stale={tier1DiffStale}
          />
        )}

        {/* diff 最终数据 */}
        {isAssistant && currentSessionId && !isDiffLoading && diffCache && (
          diffCache.diffs.length > 0 || (diffCache.skippedFiles && diffCache.skippedFiles.length > 0)
        ) && (
          <DiffViewer
            diffs={diffCache.diffs}
            reviews={diffCache.reviews}
            skippedFiles={diffCache.skippedFiles}
            sessionId={currentSessionId}
            messageId={msg.id}
            tier1Stale={tier1DiffStale}
            onRejectFile={tier1DiffStale ? undefined : (filePath) => onRejectFile(currentSessionId, msg.id, filePath)}
            onAcceptFile={tier1DiffStale ? undefined : (filePath) => onAcceptFile(currentSessionId, msg.id, filePath)}
            {...(onAcceptAllFiles && !tier1DiffStale ? { onAcceptAll: (filePaths: string[]) => onAcceptAllFiles(currentSessionId, msg.id, filePaths) } : {})}
            {...(onRejectAllFiles && !tier1DiffStale ? { onRejectAll: (filePaths: string[]) => onRejectAllFiles(currentSessionId, msg.id, filePaths) } : {})}
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
    </div>
  )
}

// ── 自定义比较：只比 primitive / reference ──────────────────

export function areEqual(prev: MessageItemProps, next: MessageItemProps): boolean {
  return (
    prev.msg.id === next.msg.id &&
    prev.msg._revision === next.msg._revision &&
    prev.renderMode === next.renderMode &&
    prev.isGenerating === next.isGenerating &&
    prev.isPausedForInput === next.isPausedForInput &&
    prev.currentGeneratingMessageId === next.currentGeneratingMessageId &&
    prev.currentMode === next.currentMode &&
    prev.currentSessionId === next.currentSessionId &&
    prev.onRegenerate === next.onRegenerate &&
    prev.regenerateBlocked === next.regenerateBlocked &&
    prev.tier1DiffStale === next.tier1DiffStale &&
    prev.rollbackError === next.rollbackError &&
    prev.onSwitchBranch === next.onSwitchBranch &&
    prev.msg.branch?.index === next.msg.branch?.index &&
    prev.msg.branch?.total === next.msg.branch?.total &&
    prev.onEditResend === next.onEditResend &&
    prev.onAcceptFile === next.onAcceptFile &&
    prev.onRejectFile === next.onRejectFile &&
    prev.onAcceptAllFiles === next.onAcceptAllFiles &&
    prev.onRejectAllFiles === next.onRejectAllFiles &&
    prev.onRenderPoolTick === next.onRenderPoolTick &&
    prev.diffCache === next.diffCache &&
    prev.isDiffLoading === next.isDiffLoading &&
    prev.diffPlaceholders === next.diffPlaceholders &&
    prev.onLoadDiffs === next.onLoadDiffs
  )
}

export const MessageItem = React.memo(MessageItemInner, areEqual)
