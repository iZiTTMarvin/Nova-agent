import type {
  XForgePlanTask,
  XForgeValidatedPlan,
  XForgePlanValidation,
  XForgeTaskState
} from '../../../shared/xforge/types'

export type { XForgePlanTask, XForgeValidatedPlan, XForgePlanValidation }

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasTextArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(hasText)
}

function hasTextArrayAllowEmpty(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(hasText)
}

function hasPlanTasks(value: unknown): value is XForgePlanTask[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      task =>
        task &&
        typeof task === 'object' &&
        hasText((task as XForgePlanTask).id) &&
        hasText((task as XForgePlanTask).title) &&
        hasTextArray((task as XForgePlanTask).acceptance)
    )
  )
}

export function validateXForgePlan(plan: Partial<XForgeValidatedPlan>): XForgePlanValidation {
  const missing: string[] = []

  if (!Number.isInteger(plan.version) || (plan.version ?? 0) < 1) missing.push('version')
  if (!hasText(plan.goal)) missing.push('goal')
  if (!hasTextArray(plan.constraints)) missing.push('constraints')
  if (!hasTextArray(plan.nonGoals)) missing.push('nonGoals')
  if (!hasTextArray(plan.repositoryFacts)) missing.push('repositoryFacts')
  if (!hasTextArray(plan.changeScope)) missing.push('changeScope')
  if (!hasPlanTasks(plan.tasks)) missing.push('tasks')
  if (!plan.acceptanceMap || typeof plan.acceptanceMap !== 'object') {
    missing.push('acceptanceMap')
  }
  if (!hasTextArrayAllowEmpty(plan.verificationChecklist)) missing.push('verificationChecklist')
  if (!hasTextArray(plan.risks)) missing.push('risks')

  if (hasPlanTasks(plan.tasks) && plan.acceptanceMap && typeof plan.acceptanceMap === 'object') {
    for (const task of plan.tasks) {
      if (!hasTextArray(plan.acceptanceMap[task.id])) {
        missing.push(`acceptanceMap.${task.id}`)
      }
    }
  }

  return { valid: missing.length === 0, missing }
}

export function createTaskStatesFromPlan(plan: XForgeValidatedPlan): XForgeTaskState[] {
  return plan.tasks.map(task => ({
    id: task.id,
    title: task.title,
    status: 'pending',
    acceptance: [...task.acceptance],
    attempts: 0,
    evidenceRefs: []
  }))
}
