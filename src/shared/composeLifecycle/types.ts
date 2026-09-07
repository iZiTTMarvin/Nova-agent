/** compose 生命周期五阶段 id（内部模式标识仍是 compose） */
export const COMPOSE_STAGE_IDS = [
  'interview',
  'blueprint',
  'build',
  'inspect',
  'deliver'
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
  /** 进入 in_progress 的时刻；缺省不回填 */
  enteredAt?: number
}

export type ComposeStageAction =
  | { type: 'complete' }
  | { type: 'skip'; reason: string }
  | { type: 'return'; targetStage: ComposeStageId; reason: string }

/** 阶段 id → 中文名（工具输出与 UI 共用） */
export const COMPOSE_STAGE_LABELS: Record<ComposeStageId, string> = {
  interview: '问',
  blueprint: '图',
  build: '锤',
  inspect: '验',
  deliver: '交'
}

export function isComposeStageId(value: string): value is ComposeStageId {
  return (COMPOSE_STAGE_IDS as readonly string[]).includes(value)
}

export type ComposePlanApprovalStatus = 'pending' | 'approved'

/**
 * 计划确认门状态：批准前 stage_transition 无法把「图」阶段 complete 掉。
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
