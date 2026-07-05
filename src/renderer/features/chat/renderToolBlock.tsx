/**
 * 单条工具块渲染分发
 *
 * - 默认：L3 ToolTraceRow（等宽原子行，L4 按需挂载）
 * - askQuestion：交互冒泡，专用卡片
 * - todo_write：轻量 Checklist 冒泡（Roadmap，默认可见）
 */
import React from 'react'
import { AskQuestionToolCard } from './AskQuestionToolCard'
import { TodoToolCard } from './TodoToolCard'
import { ToolTraceRow } from './ToolTraceRow'
import type { RendererToolBlock } from '../../stores/types'

export function renderToolBlock(
  block: RendererToolBlock,
  isCurrentAssistantGenerating: boolean
): React.ReactNode {
  const isLive = isCurrentAssistantGenerating && block.status === 'running'

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

  // write/edit 流式：优先 argumentsRaw（primitive），finalize 后走 args
  if (
    (block.toolName === 'write' || block.toolName === 'edit') &&
    block.argumentsRaw !== undefined
  ) {
    return (
      <ToolTraceRow
        key={block.toolCallId}
        toolCallId={block.toolCallId}
        name={block.toolName}
        argumentsRaw={block.argumentsRaw}
        status={block.status}
        result={block.result}
        isLiveStreaming={isLive}
      />
    )
  }

  return (
    <ToolTraceRow
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
