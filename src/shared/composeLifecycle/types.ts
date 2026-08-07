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

export type ComposePlanApprovalStatus = 'pending' | 'approved'

/**
 * 计划确认门状态：批准前 stage_transition 无法把「计划」阶段 complete 掉。
 * 每次 save_plan 成功写入后必须重置为 pending——批准针对的是已审阅过的具体内容，
 * 计划改动后旧批准不再有效。
 */
export interface ComposePlanApproval {
  status: ComposePlanApprovalStatus
  /** 批准时间戳，仅 approved 时存在 */
  approvedAt?: number
  /** auto 模式下自动放行；缺省或 false 表示用户手动点击批准 */
  auto?: boolean
}
