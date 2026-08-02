import type {
  SubagentExecutionResult,
  SubagentFailureCode,
  SubagentExecutionStatus
} from '../../shared/subagents'
import type { RunSnapshot } from '../../shared/run/types'
import type { SessionData, SessionMessage } from '../sessions/types'
import { extractTextFromSerializableContent } from '../sessions/types'

export const MAX_SUBAGENT_SUMMARY_CHARS = 8_000
const MAX_FAILURE_MESSAGE_CHARS = 1_000

export function projectSubagentExecutionResult(input: {
  readonly childSession: SessionData
  readonly runSnapshot: RunSnapshot
  readonly failureCode?: SubagentFailureCode
}): SubagentExecutionResult {
  const status = toExecutionStatus(input.runSnapshot.status)
  const finalMessage = findFinalMessage(input.childSession, input.runSnapshot.messageId)
  const rawSummary = finalMessage ? extractSummary(finalMessage) : ''
  const summary = boundText(
    rawSummary || fallbackSummary(status),
    MAX_SUBAGENT_SUMMARY_CHARS
  )
  const artifactIds = finalMessage
    ? [...new Set(
        (finalMessage.toolCalls ?? [])
          .map((toolCall) => toolCall.artifactId)
          .filter((id): id is string => Boolean(id))
      )]
    : []
  const terminalReason = input.runSnapshot.terminalReason?.trim()

  return {
    childSessionId: input.childSession.id,
    childRunId: input.runSnapshot.runId,
    status,
    summary,
    artifactIds,
    startedAt: input.runSnapshot.turnStartedAt ?? input.runSnapshot.createdAt,
    completedAt: input.runSnapshot.updatedAt,
    ...(status === 'failed'
      ? {
          failure: {
            code: input.failureCode ?? 'model',
            message: boundText(
              terminalReason || '子代理执行失败',
              MAX_FAILURE_MESSAGE_CHARS
            )
          }
        }
      : {})
  }
}

function findFinalMessage(session: SessionData, messageId: string): SessionMessage | undefined {
  if (messageId) {
    const exact = session.messages.find(
      (message) => message.id === messageId && message.role === 'assistant'
    )
    if (exact) return exact
  }
  return [...session.messages].reverse().find((message) => message.role === 'assistant')
}

function extractSummary(message: SessionMessage): string {
  if (message.blocks) {
    const text = message.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.content)
      .join('\n')
      .trim()
    if (text) return text
  }
  return extractTextFromSerializableContent(message.content).trim()
}

function toExecutionStatus(status: RunSnapshot['status']): SubagentExecutionStatus {
  if (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  ) {
    return status
  }
  throw new Error(`child run 尚未终止: ${status}`)
}

function fallbackSummary(status: SubagentExecutionStatus): string {
  switch (status) {
    case 'completed':
      return '子代理未产生文本输出'
    case 'failed':
      return '子代理执行出错'
    case 'cancelled':
      return '子代理执行已取消'
    case 'interrupted':
      return '子代理执行已中断'
  }
}

function boundText(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1))}…`
}
