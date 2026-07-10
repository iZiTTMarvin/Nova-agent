/**
 * VirtualMessageList — 消息流虚拟列表
 *
 * 职责：
 * - 动态高度测量（measureElement）+ 稳定 messageId key
 * - 只挂载视口附近 DOM，保证 500–2000 条时节点有界
 * - 配合外层 scroll 容器的 prepend 锚点修正（由 ChatPanel 负责 scrollTop 补偿）
 * - 分页仍由 useChatStore.loadOlderMessages 负责；本组件只管 DOM 上限
 *
 * 测试环境（无真实 layout / clientHeight=0）退化为全量渲染，保证接线单测可用。
 */
import React, { useEffect, useState, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ExtendedMessage } from '../../stores/types'
import type { MessageDiffCache } from '../../stores/types'
import type { DiffEntry } from '../../../shared/diff/types'
import type { Mode } from '../../../shared/session/types'
import { MessageItem } from './MessageItem'
import { resolveMessageRenderMode } from './messageRenderTier'

/** 单条消息预估高度（含间距）；真实高度由 measureElement 校正 */
const ESTIMATED_MESSAGE_HEIGHT_PX = 140
/** 消息间距（替代 flex gap，绝对定位下需手动留白） */
const MESSAGE_GAP_PX = 24
/** 视口外额外挂载条数 */
const OVERSCAN = 6

export interface VirtualMessageListProps {
  messages: ExtendedMessage[]
  scrollElement: HTMLDivElement | null
  isGenerating: boolean
  currentGeneratingMessageId: string | null
  currentMode: Mode
  currentSessionId: string | null
  onRegenerate: (messageId: string) => void | Promise<void>
  onSwitchBranch: (targetMessageId: string) => void | Promise<void>
  onEditResend: (messageId: string, newContent: string) => void | Promise<void>
  tier1StaleDiffSet: Set<string>
  rollbackErrors: Record<string, string | undefined>
  onAcceptFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>
  onRejectFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>
  onAcceptAllFiles: (sessionId: string, messageId: string, filePaths: string[]) => Promise<void>
  onRejectAllFiles: (
    sessionId: string,
    messageId: string,
    filePaths: string[]
  ) => Promise<{ restored: string[]; failed: Array<{ filePath: string; error: string }> }>
  onRenderPoolTick: () => void
  isPausedForUserInput: boolean
  pausedMessageId: string | null
  messageDiffs: Record<string, MessageDiffCache>
  loadingDiffs: Set<string>
  loadingDiffPlaceholders: Record<string, Array<{ filePath: string; status: DiffEntry['status'] }>>
  onLoadDiffs: (sessionId: string, messageId: string) => void | Promise<void>
}

function renderMessageRow(
  msg: ExtendedMessage,
  rowIndex: number,
  total: number,
  props: VirtualMessageListProps
): React.ReactNode {
  const {
    isGenerating,
    currentGeneratingMessageId,
    currentMode,
    currentSessionId,
    onRegenerate,
    onSwitchBranch,
    onEditResend,
    tier1StaleDiffSet,
    rollbackErrors,
    onAcceptFile,
    onRejectFile,
    onAcceptAllFiles,
    onRejectAllFiles,
    onRenderPoolTick,
    isPausedForUserInput,
    pausedMessageId,
    messageDiffs,
    loadingDiffs,
    loadingDiffPlaceholders,
    onLoadDiffs,
    messages
  } = props

  const diffCache = messageDiffs[msg.id]
  const isDiffLoading = loadingDiffs.has(msg.id)
  const diffPlaceholders = loadingDiffPlaceholders[msg.id]
  const renderMode = resolveMessageRenderMode(rowIndex, total, isGenerating)
  const prevMsg = rowIndex > 0 ? messages[rowIndex - 1] : undefined
  const regenerateBlocked =
    msg.role === 'assistant'
    && prevMsg?.role === 'user'
    && !!prevMsg.blocks?.some(b => b.type === 'image')

  return (
    <MessageItem
      key={msg.id}
      msg={msg}
      renderMode={renderMode}
      isGenerating={isGenerating}
      currentGeneratingMessageId={currentGeneratingMessageId}
      currentMode={currentMode}
      currentSessionId={currentSessionId}
      onRegenerate={onRegenerate}
      regenerateBlocked={regenerateBlocked}
      onSwitchBranch={onSwitchBranch}
      tier1DiffStale={tier1StaleDiffSet.has(msg.id)}
      onEditResend={onEditResend}
      rollbackError={rollbackErrors[msg.id]}
      onAcceptFile={onAcceptFile}
      onRejectFile={onRejectFile}
      onAcceptAllFiles={onAcceptAllFiles}
      onRejectAllFiles={onRejectAllFiles}
      onRenderPoolTick={onRenderPoolTick}
      isPausedForInput={isPausedForUserInput && msg.id === pausedMessageId}
      diffCache={diffCache}
      isDiffLoading={isDiffLoading}
      diffPlaceholders={diffPlaceholders}
      onLoadDiffs={onLoadDiffs}
    />
  )
}

export const VirtualMessageList: React.FC<VirtualMessageListProps> = (props) => {
  const { messages, scrollElement } = props
  const [viewportReady, setViewportReady] = useState(false)

  // 检测滚动容器是否有真实布局尺寸（jsdom / TestRenderer 通常为 0）
  useEffect(() => {
    if (!scrollElement) {
      setViewportReady(false)
      return
    }
    const check = (): void => {
      setViewportReady(scrollElement.clientHeight > 0)
    }
    check()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(check)
    ro.observe(scrollElement)
    return () => ro.disconnect()
  }, [scrollElement])

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ESTIMATED_MESSAGE_HEIGHT_PX + MESSAGE_GAP_PX,
    overscan: OVERSCAN,
    getItemKey: useCallback((index: number) => messages[index]?.id ?? index, [messages]),
    enabled: viewportReady && messages.length > 0
  })

  // 无真实视口：只挂载尾部窗口，禁止全量 messages.map（2000 条时首帧必须常数级）
  if (!viewportReady) {
    const tailWindow = Math.max(OVERSCAN * 2, 12)
    const start = Math.max(0, messages.length - tailWindow)
    const slice = messages.slice(start)
    return (
      <div
        className="chat-messages__virtual-fallback"
        data-virtual="fallback"
        data-mounted-count={slice.length}
        data-total-count={messages.length}
      >
        {slice.map((msg, i) => {
          const rowIndex = start + i
          return (
            <div key={msg.id} className="chat-messages__virtual-row" data-index={rowIndex}>
              {renderMessageRow(msg, rowIndex, messages.length, props)}
            </div>
          )
        })}
      </div>
    )
  }

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div
      className="chat-messages__virtual"
      data-virtual="active"
      data-mounted-count={virtualItems.length}
      data-total-count={messages.length}
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        width: '100%',
        position: 'relative'
      }}
    >
      {virtualItems.map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          ref={virtualizer.measureElement}
          className="chat-messages__virtual-row"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${item.start}px)`,
            paddingBottom: MESSAGE_GAP_PX
          }}
        >
          {renderMessageRow(messages[item.index], item.index, messages.length, props)}
        </div>
      ))}
    </div>
  )
}
