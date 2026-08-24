/**
 * 单条工具块渲染分发
 *
 * - 默认：L3 ToolTraceRow（等宽原子行，L4 按需挂载）
 * - askQuestion：消息内状态行（正在询问 / 已询问 N 题）；答题在底部 AskQuestionPanel
 * - todo_write：由会话顶部 TodoPanel 统一渲染，此处返回 null 避免与消息流重复
 */
import React from 'react'
import type { PendingPlanReview } from '../../../shared/planReview'
import { isPlanReviewIgnoredResult } from '../../../shared/planReview'
import { AskQuestionToolCard } from './AskQuestionToolCard'
import { PlanApprovalCard, PlanApprovalIgnoredCard } from './PlanApprovalCard'
import { PlanReviewCard } from './PlanReviewCard'
import { ToolTraceRow } from './ToolTraceRow'
import type { RendererToolBlock } from '../../stores/types'
import { SubagentToolRow } from '../subagents/SubagentActivityRow'

export interface RenderToolBlockContext {
  messageId: string
  sessionId?: string | null
  pendingPlanReview?: PendingPlanReview | null
}

export function renderToolBlock(
  block: RendererToolBlock,
  isCurrentAssistantGenerating: boolean,
  context?: RenderToolBlockContext
): React.ReactNode {
  // 工具级：瞬时工具（askQuestion / write / edit / 默认行）流式态，工具完成即结束
  const isLive = isCurrentAssistantGenerating && block.status === 'running'

  // todo_write 由会话顶部 TodoPanel 统一渲染，不在消息流里重复展示
  if (block.toolName === 'todo_write') {
    return null
  }

  if (block.toolName === 'save_plan') {
    if (!context?.sessionId) return null
    return (
      <PlanReviewCard
        key={block.toolCallId}
        sessionId={context.sessionId}
        messageId={context.messageId}
        toolCallId={block.toolCallId}
        status={block.status}
        args={block.arguments}
        result={block.result}
      />
    )
  }

  if (block.toolName === 'switch_mode' || block.toolName === 'stage_transition') {
    // 控制面工具只有两种可见形态：等待审批的交互卡，以及忽略决定随工具结果持久化后的灰态记录
    if (context?.pendingPlanReview?.toolCallId === block.toolCallId) {
      return <PlanApprovalCard key={block.toolCallId} review={context.pendingPlanReview} />
    }
    if (isPlanReviewIgnoredResult(block.result)) {
      return <PlanApprovalIgnoredCard key={block.toolCallId} />
    }
    return null
  }

  if (block.toolName === 'askQuestion') {
    return (
      <AskQuestionToolCard
        key={block.toolCallId}
        toolCallId={block.toolCallId}
        args={block.arguments}
        status={block.status}
        result={block.result}
        isLiveStreaming={isLive}
      />
    )
  }

  if (block.toolName === 'task') {
    return (
      <SubagentToolRow
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
      nestedActivities={block.nestedActivities}
    />
  )
}
