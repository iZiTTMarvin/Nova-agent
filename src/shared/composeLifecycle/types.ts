/** compose 生命周期六阶段 id（与既有 compose 词汇对齐，独立契约） */
export const COMPOSE_STAGE_IDS = [
  'brainstorm',
  'plan',
  'implement',
  'verify',
  'review',
  'report'
] as const

export type ComposeStageId = (typeof COMPOSE_STAGE_IDS)[number]

export type ComposeStageStatus = 'pending' | 'in_progress' | 'completed' | 'skipped'

export interface ComposeStageEntry {
  id: ComposeStageId
  status: ComposeStageStatus
  /** 跳过或回退原因 */
  note?: string
  /** 进入 completed / skipped 时写入 */
  completedAt?: number
}

export type ComposeStageAction =
  | { type: 'complete' }
  | { type: 'skip'; reason: string }
  | { type: 'return'; targetStage: ComposeStageId; reason: string }

/** 阶段 id → 中文名（工具输出与 UI 共用） */
export const COMPOSE_STAGE_LABELS: Record<ComposeStageId, string> = {
  brainstorm: '构思',
  plan: '计划',
  implement: '开发',
  verify: '验证',
  review: '审查',
  report: '收尾'
}

export function isComposeStageId(value: string): value is ComposeStageId {
  return (COMPOSE_STAGE_IDS as readonly string[]).includes(value)
}
