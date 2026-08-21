import type { ToolExecutor, ToolContext, ToolResult } from '../types'
import {
  COMPOSE_STAGE_IDS,
  COMPOSE_STAGE_LABELS,
  getPlanCompleteDenial,
  isComposeStageId,
  type ComposeStageAction,
  type ComposeStageEntry
} from '../../../shared/composeLifecycle'

function failed(error: string): ToolResult {
  return { success: false, output: '', error }
}

function parseAction(args: Record<string, unknown>): ComposeStageAction | string {
  const action = args.action
  if (action !== 'complete' && action !== 'skip' && action !== 'return') {
    return 'action 必须是 complete、skip 或 return'
  }

  if (action === 'complete') {
    return { type: 'complete' }
  }

  const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
  if (!reason) {
    return action === 'skip' ? '跳过阶段必须提供原因' : '回退阶段必须提供原因'
  }

  if (action === 'skip') {
    return { type: 'skip', reason }
  }

  const targetStage = args.targetStage
  if (typeof targetStage !== 'string' || !isComposeStageId(targetStage)) {
    return '回退必须提供合法的 targetStage'
  }
  return { type: 'return', targetStage, reason }
}

function labelOf(id: ComposeStageEntry['id']): string {
  return COMPOSE_STAGE_LABELS[id]
}

function formatSuccessOutput(
  action: ComposeStageAction,
  stages: ComposeStageEntry[],
  previousStages: ComposeStageEntry[] | null
): string {
  const prevInProgress =
    previousStages?.find(s => s.status === 'in_progress') ??
    (previousStages == null ? { id: 'brainstorm' as const } : undefined)

  if (action.type === 'complete') {
    const doneId = prevInProgress?.id
    const next = stages.find(s => s.status === 'in_progress')
    if (doneId && next) {
      return `已完成「${labelOf(doneId)}」阶段，进入「${labelOf(next.id)}」阶段。`
    }
    if (doneId) {
      return `已完成「${labelOf(doneId)}」阶段，生命周期已结束。`
    }
    return '阶段已完成。'
  }

  if (action.type === 'skip') {
    const skippedId = prevInProgress?.id
    const next = stages.find(s => s.status === 'in_progress')
    if (skippedId && next) {
      return `已跳过「${labelOf(skippedId)}」阶段，进入「${labelOf(next.id)}」阶段。原因：${action.reason}`
    }
    if (skippedId) {
      return `已跳过「${labelOf(skippedId)}」阶段，生命周期已结束。原因：${action.reason}`
    }
    return `已跳过当前阶段。原因：${action.reason}`
  }

  return `已回退到「${labelOf(action.targetStage)}」阶段，其间阶段已重置。原因：${action.reason}`
}

export const stageTransitionTool: ToolExecutor = {
  name: 'stage_transition',
  description:
    '仅 compose 模式：推进生命周期阶段。' +
    'complete 完成当前阶段并进入下一阶段；' +
    'skip 跳过当前阶段（必须给原因）；' +
    'return 回退到更早阶段（必须给 targetStage 与原因）。',
  executionMode: 'sequential',
  isConcurrencySafe: () => false,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['complete', 'skip', 'return'],
        description: '阶段转换动作：完成、跳过或回退'
      },
      reason: {
        type: 'string',
        description: '跳过或回退时必填的原因'
      },
      targetStage: {
        type: 'string',
        enum: [...COMPOSE_STAGE_IDS],
        description: '回退目标阶段（仅 return 时必填）'
      }
    },
    required: ['action'],
    additionalProperties: false
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (context.mode !== 'compose') {
      return failed('stage_transition 仅在 compose 模式可用')
    }

    const parsed = parseAction(args)
    if (typeof parsed === 'string') {
      return failed(parsed)
    }

    const sessionStore = context.sessionStore
    const sessionId = context.sessionId
    if (!sessionStore || !sessionId) {
      return failed('缺少会话上下文，无法推进生命周期阶段')
    }

    if (parsed.type === 'complete') {
      const stages = sessionStore.getComposeStages(sessionId)
      const denial = getPlanCompleteDenial(
        stages,
        // 无阶段表时无需读批准状态，交由 apply 统一报错/建表
        stages ? sessionStore.getComposePlanApproval(sessionId) : null
      )
      if (denial) {
        // auto 模式自动放行并留痕（approveComposePlan 记 auto: true，同时 emit 事件
        // 让审阅卡实时反映"自动批准"而非用户手动点击）
        if (context.autoMode) {
          const approved = sessionStore.approveComposePlan(sessionId, { auto: true })
          if (approved) {
            context.eventBus?.emit({
              type: 'compose_plan_approval_updated',
              sessionId,
              approval: approved
            })
          }
        } else {
          return failed(denial)
        }
      }
    }

    const result = sessionStore.applyComposeStageTransition(sessionId, parsed)
    if (result === null) {
      return failed('会话不存在')
    }
    if (result.status === 'rejected') {
      return failed(result.error)
    }

    context.eventBus?.emit({
      type: 'compose_stages_updated',
      sessionId,
      stages: result.stages,
      reviewLoops: result.reviewLoops
    })

    return {
      success: true,
      output: formatSuccessOutput(parsed, result.stages, result.previousStages)
    }
  }
}
