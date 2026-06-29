/**
 * 单条工具块渲染：按工具类型分发到专用卡片或通用 ToolBox
 */
import React from 'react'
import { StreamingFileCard, type StreamingFileCardProps } from './StreamingFileCard'
import { AskQuestionToolCard } from './AskQuestionToolCard'
import { TodoToolCard } from './TodoToolCard'
import { ToolBox } from './ToolBox'
import type { RendererToolBlock } from '../../stores/types'

export function renderToolBlock(
  block: RendererToolBlock,
  isCurrentAssistantGenerating: boolean
): React.ReactNode {
  const isLive = isCurrentAssistantGenerating && block.status === 'running'

  if (block.toolName === 'write' || block.toolName === 'edit') {
    const cardProps: StreamingFileCardProps = block.argumentsRaw === undefined
      ? {
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          status: block.status,
          args: block.arguments,
          result: block.result
        }
      : {
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          status: block.status,
          argumentsRaw: block.argumentsRaw,
          result: block.result
        }
    return <StreamingFileCard key={block.toolCallId} {...cardProps} />
  }

  if (block.toolName === 'askQuestion') {
    return (
      <AskQuestionToolCard
        key={block.toolCallId}
        toolCallId={block.toolCallId}
        args={block.arguments}
        status={block.status}
        isLiveStreaming={isLive}
      />
    )
  }

  if (block.toolName === 'todo_write') {
    return (
      <TodoToolCard
        key={block.toolCallId}
        toolCallId={block.toolCallId}
        args={block.arguments}
        status={block.status}
        isLiveStreaming={isLive}
      />
    )
  }

  return (
    <ToolBox
      key={block.toolCallId}
      toolCallId={block.toolCallId}
      name={block.toolName}
      args={block.arguments}
      status={block.status}
      result={block.result}
      isLiveStreaming={isLive}
    />
  )
}
