/**
 * L3 过程轨迹列表：map ProcessSegment → 现有 ThinkingBlock / ToolTraceRow / ToolCallGroup 等。
 */
import React from 'react'
import { ThinkingBlock } from './ThinkingBlock'
import { StreamingTextBlock } from './StreamingTextBlock'
import { ToolCallGroup } from './ToolCallGroup'
import { renderToolBlock } from './renderToolBlock'
import { isActiveThinkingBlock } from './renderingPolicy'
import { shouldEnableTextBlockTypewriter } from './textBlockTypewriterPolicy'
import type { ProcessSegment } from './turnProcessModel'
import type { RendererMessageBlock } from '../../stores/types'

export interface ProcessTraceListProps {
  segments: ProcessSegment[]
  messageId: string
  blocks: RendererMessageBlock[]
  isTurnActiveForThisMsg: boolean
  isPausedForInput: boolean
  isCurrentAssistantGenerating: boolean
  onRenderPoolTick?: () => void
}

function segmentKey(segment: ProcessSegment, idx: number): string {
  if (segment.kind === 'block') {
    return `block-${segment.index}-${segment.block.type}-${idx}`
  }
  if (segment.kind === 'toolGroup') {
    return `group-${segment.blocks.map(b => b.toolCallId).join('-')}`
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
  onRenderPoolTick
}) {
  return (
    <div className="turn-process-trace-list">
      {segments.map((segment, idx) => {
        if (segment.kind === 'block') {
          const { block, index } = segment
          if (block.type === 'thinking') {
            return (
              <ThinkingBlock
                key={segmentKey(segment, idx)}
                thinking={block.content}
                active={isActiveThinkingBlock(
                  blocks,
                  index >= 0 ? index : blocks.length - 1,
                  isTurnActiveForThisMsg && !isPausedForInput,
                  messageId,
                  isTurnActiveForThisMsg ? messageId : null
                )}
              />
            )
          }
          if (block.type === 'text') {
            const enableTypewriter =
              index >= 0 &&
              shouldEnableTextBlockTypewriter({
                isTurnActive: isTurnActiveForThisMsg,
                blockIndex: index,
                blocks
              })
            return (
              <div key={segmentKey(segment, idx)} className="turn-process-text">
                <StreamingTextBlock
                  fullContent={block.content}
                  isStreaming={isTurnActiveForThisMsg}
                  enableTypewriter={enableTypewriter}
                  paused={isPausedForInput}
                  onRenderPoolTick={onRenderPoolTick}
                />
              </div>
            )
          }
          return null
        }

        if (segment.kind === 'toolGroup') {
          const groupKey = segment.blocks.map(b => b.toolCallId).join('-')
          return (
            <ToolCallGroup
              key={`group-${groupKey}`}
              toolName={segment.toolName}
              blocks={segment.blocks}
            />
          )
        }

        if (segment.kind === 'tool') {
          return renderToolBlock(segment.block, isCurrentAssistantGenerating)
        }

        return null
      })}
    </div>
  )
})
