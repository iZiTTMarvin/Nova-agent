import type { PendingInteraction, RunSnapshot } from '../run/types'

export type PlanReviewDecision = 'approve' | 'revise' | 'ignore'

export interface PlanReviewCommand {
  interactionId: string
  commandId: string
  expectedVersion: number
  decision: PlanReviewDecision
  feedback?: string
}

export type PlanReviewResolution =
  | { decision: 'approve' }
  | { decision: 'revise'; feedback: string }
  | { decision: 'ignore' }

/**
 * 忽略决定写入 switch_mode / stage_transition 工具结果的开头标记。
 * 工具结果随消息持久化，渲染层据此在历史中恢复灰态「已忽略」卡，跨 run 与重启仍成立。
 */
export const PLAN_REVIEW_IGNORED_RESULT_MARKER = '用户选择忽略当前计划'

export function isPlanReviewIgnoredResult(result: string | undefined): boolean {
  return typeof result === 'string' && result.startsWith(PLAN_REVIEW_IGNORED_RESULT_MARKER)
}

export type PendingPlanReview = {
  interactionId: string
  commandVersion: number
  runId: string
  sessionId: string
  messageId: string
  toolCallId: string
  source: 'plan' | 'compose'
}

export type PlanReviewCommandParseResult =
  | { ok: true; command: PlanReviewCommand }
  | { ok: false; message: string }

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function parsePlanReviewCommand(value: unknown): PlanReviewCommandParseResult {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, message: '计划审阅命令必须是对象' }
  }

  const input = value as Record<string, unknown>
  const allowedKeys = new Set([
    'interactionId',
    'commandId',
    'expectedVersion',
    'decision',
    'feedback'
  ])
  if (Object.keys(input).some(key => !allowedKeys.has(key))) {
    return { ok: false, message: '计划审阅命令包含未知字段' }
  }
  if (!nonEmptyString(input.interactionId)) {
    return { ok: false, message: '缺少 interactionId' }
  }
  if (!nonEmptyString(input.commandId)) {
    return { ok: false, message: '缺少 commandId' }
  }
  if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) {
    return { ok: false, message: 'expectedVersion 必须是正整数' }
  }
  if (input.decision !== 'approve' && input.decision !== 'revise' && input.decision !== 'ignore') {
    return { ok: false, message: 'decision 必须是 approve、revise 或 ignore' }
  }

  const feedback = typeof input.feedback === 'string' ? input.feedback.trim() : ''
  if (input.decision === 'revise' && !feedback) {
    return { ok: false, message: '修改计划时必须提供反馈' }
  }
  if (input.decision !== 'revise' && input.feedback !== undefined) {
    return { ok: false, message: '仅 revise 决定可以携带 feedback' }
  }

  return {
    ok: true,
    command: {
      interactionId: input.interactionId,
      commandId: input.commandId,
      expectedVersion: Number(input.expectedVersion),
      decision: input.decision,
      ...(input.decision === 'revise' ? { feedback } : {})
    }
  }
}

export function projectPendingPlanReview(
  snapshot: RunSnapshot | null | undefined
): PendingPlanReview | null {
  if (!snapshot) return null
  const candidates = snapshot.pendingInteractions
    .filter(isPendingPlanReviewInteraction)
    .filter(i => !i.expiresAt || i.expiresAt > Date.now())
  if (candidates.length === 0) return null
  // 同快照内若残留多个 plan review，取版本最高（最新）的一个，避免旧 interaction 残留导致投影 stale。
  const interaction = candidates.reduce((newest, current) =>
    current.version > newest.version ? current : newest
  )

  const payloadToolCallId = interaction.payload.toolCallId
  const permissionToolCallIds = interaction.payload.toolCallIds
  const toolCallId = nonEmptyString(payloadToolCallId)
    ? payloadToolCallId
    : Array.isArray(permissionToolCallIds) && nonEmptyString(permissionToolCallIds[0])
      ? permissionToolCallIds[0]
      : null
  if (!toolCallId) return null

  return {
    interactionId: interaction.interactionId,
    commandVersion: interaction.version,
    runId: interaction.runId,
    sessionId: interaction.sessionId,
    messageId: interaction.messageId,
    toolCallId,
    source: interaction.type === 'planApproval' ? 'compose' : 'plan'
  }
}

export function isPlanReviewPermissionPayload(payload: Readonly<Record<string, unknown>>): boolean {
  const args = payload.args
  return payload.toolName === 'switch_mode' &&
    typeof args === 'object' &&
    args !== null &&
    (args as Record<string, unknown>).mode === 'default'
}

function isPendingPlanReviewInteraction(interaction: PendingInteraction): boolean {
  if (interaction.status !== 'pending' && interaction.status !== 'submitting') return false
  if (interaction.type === 'planApproval') {
    return interaction.payload.toolName === 'stage_transition' &&
      interaction.payload.action === 'complete'
  }
  return interaction.type === 'permission' && isPlanReviewPermissionPayload(interaction.payload)
}
