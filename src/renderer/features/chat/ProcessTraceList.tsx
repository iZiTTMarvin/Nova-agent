/**
 * L3 过程轨迹列表：map ProcessSegment → ThinkingBlock / ToolTraceRow / 活动组（ToolCallGroup）等。
 */
import React, { useCallback, useState } from 'react'
import { ThinkingBlock } from './ThinkingBlock'
import { StreamingTextBlock } from './StreamingTextBlock'
import { InlineUiScopeProvider, useInlineUiHost } from '../inline-ui/InlineUiScope'
import { ToolCallGroup } from './ToolCallGroup'
import { renderToolBlock } from './renderToolBlock'
import { isActiveThinkingBlock } from './renderingPolicy'
import { shouldEnableTextBlockTypewriter } from './textBlockTypewriterPolicy'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type { PendingPlanReview } from '../../../shared/planReview'
import type { ActivityItem, ProcessSegment } from './turnProcessModel'
import type { RendererMessageBlock } from '../../stores/types'

export interface ProcessTraceListProps {
  segments: ProcessSegment[]
  messageId: string
  blocks: RendererMessageBlock[]
  isTurnActiveForThisMsg: boolean
  isPausedForInput: boolean
  isCurrentAssistantGenerating: boolean
  /** 末段活动组默认展开（回合进行中或被中断）；其后一旦出现说话即自动收起 */
  keepLastActivityOpen?: boolean
  sessionId?: string | null
  pendingPlanReview?: PendingPlanReview | null
  onRenderPoolTick?: () => void
}

function segmentKey(segment: ProcessSegment, idx: number): string {
  if (segment.kind === 'block') {
    return `block-${segment.index}-${segment.block.type}-${idx}`
  }
  if (segment.kind === 'activity') {
    // 以首项为组身份：新项加入时组不重挂载，已展开的详情不会收起
    return `group-${segment.id}`
  }
  return `tool-${segment.block.toolCallId}`
}

export const ProcessTraceList: React.FC<ProcessTraceListProps> = React.memo(function ProcessTraceList({
  segments,
  messageId,
  blocks,
  isTurnActiveForThisMsg,
  isPausedForInput,
  isCurrentAssistantGenerating,
  keepLastActivityOpen = false,
  sessionId,
  pendingPlanReview,
  onRenderPoolTick
}) {
  // 流式节奏（smooth=打字机平滑 / instant=即时显示）：设置直读，学习模式等轨迹路径共用
  const streamSmoothness = useSettingsStore(state => state.streamSmoothness)
  const streamStyle: 'agile' | 'elegant' = streamSmoothness === 'instant' ? 'agile' : 'elegant'
  const inlineUiHost = useInlineUiHost()
  // 单条调用变成分组时组件类型会变、行会重挂载；展开状态放在这里（可丢弃的界面状态），阅读现场不丢
  const [traceOpen, setTraceOpen] = useState<Readonly<Record<string, boolean>>>({})
  const handleTraceOpenChange = useCallback((key: string, open: boolean) => {
    setTraceOpen(previous => (previous[key] === open ? previous : { ...previous, [key]: open }))
  }, [])

  const renderThinking = useCallback((item: Extract<ActivityItem, { kind: 'block' }>, key?: string) => {
    const { block, index } = item
    return (
      <ThinkingBlock
        key={key}
        thinking={block.content}
        messageId={messageId}
        blockIndex={index >= 0 ? index : 0}
        durationMs={block.durationMs}
        active={isActiveThinkingBlock(
          blocks,
          index >= 0 ? index : blocks.length - 1,
          isTurnActiveForThisMsg && !isPausedForInput,
          messageId,
          isTurnActiveForThisMsg ? messageId : null
        )}
      />
    )
  }, [blocks, isPausedForInput, isTurnActiveForThisMsg, messageId])

  return (
    <div className="turn-process-trace-list">
      {segments.map((segment, idx) => {
        if (segment.kind === 'block') {
          const { block, index } = segment
          if (block.type === 'thinking') {
            return renderThinking({ kind: 'block', block, index }, segmentKey(segment, idx))
          }
          if (block.type === 'text') {
            const enableTypewriter =
              index >= 0 &&
              shouldEnableTextBlockTypewriter({
                isTurnActive: isTurnActiveForThisMsg,
                blockIndex: index,
                blocks
              })
            const textBlock = (
              <StreamingTextBlock
                fullContent={block.content}
                isStreaming={isTurnActiveForThisMsg}
                style={streamStyle}
                enableTypewriter={enableTypewriter}
                paused={isPausedForInput}
                onRenderPoolTick={onRenderPoolTick}
              />
            )
            return (
              <div key={segmentKey(segment, idx)} className="turn-process-text">
                {/* openui 状态作用域只挂到助手正文文本块；thinking 与工具分支不提供 */}
                {inlineUiHost && sessionId && index >= 0 ? (
                  <InlineUiScopeProvider sessionId={sessionId} messageId={messageId} blockIndex={index}>
                    {textBlock}
                  </InlineUiScopeProvider>
                ) : (
                  textBlock
                )}
              </div>
            )
          }
          return null
        }

        if (segment.kind === 'activity') {
          return (
            <ToolCallGroup
              key={segmentKey(segment, idx)}
              items={segment.items}
              groupId={segment.id}
              defaultOpen={segment.isLast && keepLastActivityOpen}
              renderThinking={renderThinking}
              isGenerating={isCurrentAssistantGenerating}
              traceOpen={traceOpen}
              onTraceOpenChange={handleTraceOpenChange}
            />
          )
        }

        if (segment.kind === 'tool') {
          return renderToolBlock(segment.block, isCurrentAssistantGenerating, {
            messageId,
            sessionId,
            pendingPlanReview,
            traceOpen,
            onTraceOpenChange: handleTraceOpenChange
          })
        }

        return null
      })}
    </div>
  )
})
