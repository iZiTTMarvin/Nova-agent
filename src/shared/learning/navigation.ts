/** 固定六类顶层导航维度。 */
export const LEARNING_NAV_DIMENSIONS = [
  'project_purpose',
  'startup_runtime',
  'module_roles',
  'key_user_flows',
  'data_and_state',
  'design_tradeoffs'
] as const

export type LearningNavDimensionId = (typeof LEARNING_NAV_DIMENSIONS)[number]

export type LearningNavEntryStatus = 'verified' | 'inference' | 'pending_review' | 'empty'

export interface LearningNavDimensionView {
  readonly id: LearningNavDimensionId
  readonly label: string
  readonly status: LearningNavEntryStatus
  readonly summary: string
}

export interface LearningZeroModelNavigationView {
  readonly dimensions: readonly LearningNavDimensionView[]
  readonly knowledgeRevision: string | null
  readonly hasPublishedNodes: boolean
}

const LABELS: Record<LearningNavDimensionId, string> = {
  project_purpose: '项目用途',
  startup_runtime: '启动与运行',
  module_roles: '模块职责',
  key_user_flows: '关键用户流程',
  data_and_state: '数据与状态',
  design_tradeoffs: '设计与取舍'
}

export function learningNavDimensionLabel(id: LearningNavDimensionId): string {
  return LABELS[id]
}

export function emptyNavigationDimensions(): readonly LearningNavDimensionView[] {
  return LEARNING_NAV_DIMENSIONS.map(id => ({
    id,
    label: LABELS[id],
    status: 'empty' as const,
    summary: '待整理'
  }))
}
