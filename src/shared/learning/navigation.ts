/** 大纲固定六类顶层分组；顺序即界面展示顺序。 */
export const LEARNING_NAV_DIMENSIONS = [
  'project_purpose',
  'startup_runtime',
  'module_roles',
  'key_user_flows',
  'data_and_state',
  'design_tradeoffs'
] as const

export type LearningNavDimensionId = (typeof LEARNING_NAV_DIMENSIONS)[number]
