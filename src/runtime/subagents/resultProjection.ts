import type {
  JsonSchema,
  SubagentExecutionResult,
  SubagentFailureCode,
  SubagentExecutionStatus
} from '../../shared/subagents'
import type { RunSnapshot } from '../../shared/run/types'
import type { SessionData, SessionMessage } from '../sessions/types'
import { extractTextFromSerializableContent } from '../sessions/types'
import { extractJsonCandidates } from './jsonExtract'

export const MAX_SUBAGENT_SUMMARY_CHARS = 8_000
const MAX_FAILURE_MESSAGE_CHARS = 1_000

export function projectSubagentExecutionResult(input: {
  readonly childSession: SessionData
  readonly runSnapshot: RunSnapshot
  readonly failureCode?: SubagentFailureCode
  readonly resultSchema?: JsonSchema
}): SubagentExecutionResult {
  const status = toExecutionStatus(input.runSnapshot)
  const finalMessage = findFinalMessage(input.childSession, input.runSnapshot.messageId)
  const rawSummary = finalMessage ? extractSummary(finalMessage) : ''
  // 结构化结果必须在截断前解析：summary 只承担展示用途，长结果会被截成非法 JSON。
  const structuredResult = input.resultSchema === undefined
    ? undefined
    : selectStructuredResult(input.resultSchema, rawSummary)
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
  const incompleteReason = input.runSnapshot.incompleteReason

  return {
    childSessionId: input.childSession.id,
    childRunId: input.runSnapshot.runId,
    status,
    summary,
    ...(structuredResult ? { structuredResult } : {}),
    artifactIds,
    startedAt: input.runSnapshot.turnStartedAt ?? input.runSnapshot.createdAt,
    completedAt: input.runSnapshot.updatedAt,
    ...(status === 'incomplete' && incompleteReason
      ? { incompleteReason }
      : {}),
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

/**
 * 从子代理完整文本中挑出与 schema 相符的对象候选。
 * 模型常在结构化结果外附带散文或示例块，因此按 required 键筛选而非取首个候选。
 */
export function selectStructuredResult(
  schema: JsonSchema,
  text: string
): Record<string, unknown> | undefined {
  if (schema === false) return undefined
  const required =
    typeof schema === 'object' && schema.type === 'object' && schema.required
      ? schema.required
      : []
  for (const candidate of extractJsonCandidates(text)) {
    if (!isJsonObject(candidate)) continue
    if (required.every((key) => key in candidate)) return candidate
  }
  return undefined
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function toExecutionStatus(run: RunSnapshot): SubagentExecutionStatus {
  // completed + 截断原因 = 轮次结束但任务未声称完成
  if (run.status === 'completed' && run.incompleteReason) {
    return 'incomplete'
  }
  if (
    run.status === 'completed' ||
    run.status === 'failed' ||
    run.status === 'cancelled' ||
    run.status === 'interrupted'
  ) {
    return run.status
  }
  throw new Error(`child run 尚未终止: ${run.status}`)
}

function fallbackSummary(status: SubagentExecutionStatus): string {
  switch (status) {
    case 'completed':
      return '子代理未产生文本输出'
    case 'incomplete':
      return '子代理未完成任务'
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
