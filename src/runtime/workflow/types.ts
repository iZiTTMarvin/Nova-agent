/** 单个实现任务节点；dependsOn 是 implement 批次调度的唯一依赖来源。 */
export interface PlanTask {
  id: string
  title: string
  dependsOn: string[]
  acceptance: string[]
}

/** plan 阶段交给 compose implement 的结构化计划。 */
export interface WorkflowPlan {
  version: number
  goal: string
  constraints: string[]
  nonGoals: string[]
  repositoryFacts: string[]
  changeScope: string[]
  tasks: PlanTask[]
  acceptanceMap: Record<string, string[]>
  verificationChecklist: string[]
  risks: string[]
}
