import type { HostFns, AgentResult } from '../../host'
import type { PlanTask, WorkflowPlan } from '../../types'
import type { ActivePlanDocument, BrainstormResult } from './types'

export const PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    version: { type: 'number' },
    goal: { type: 'string' },
    constraints: { type: 'array', items: { type: 'string' } },
    nonGoals: { type: 'array', items: { type: 'string' } },
    repositoryFacts: { type: 'array', items: { type: 'string' } },
    changeScope: { type: 'array', items: { type: 'string' } },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          acceptance: { type: 'array', items: { type: 'string' } }
        },
        required: ['id', 'title', 'dependsOn', 'acceptance']
      }
    },
    acceptanceMap: { type: 'object' },
    verificationChecklist: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } }
  },
  required: [
    'version',
    'goal',
    'constraints',
    'nonGoals',
    'repositoryFacts',
    'changeScope',
    'tasks',
    'acceptanceMap',
    'verificationChecklist',
    'risks'
  ]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asStringList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
}

function asVersion(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1
}

function hasCycle(tasks: PlanTask[]): boolean {
  const graph = new Map(tasks.map((task) => [task.id, task.dependsOn]))
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const dependency of graph.get(id) ?? []) {
      if (visit(dependency)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }

  return tasks.some((task) => visit(task.id))
}

function normalizeTask(value: unknown, index: number): PlanTask | null {
  const record = asRecord(value)
  if (!record) return null
  const id = asString(record.id) ?? `task-${String(index + 1).padStart(3, '0')}`
  const title = asString(record.title) ?? asString(record.name)
  if (!title) return null
  const dependsOn = [...new Set(asStringList(record.dependsOn ?? record.deps))]
  const acceptance = asStringList(
    record.acceptance ?? record.acceptanceCriteria ?? record.verifyCriteria ?? record.verify
  )
  return { id, title, dependsOn, acceptance }
}

function normalizeAcceptanceMap(value: unknown, tasks: PlanTask[]): Record<string, string[]> {
  const record = asRecord(value)
  const result: Record<string, string[]> = {}
  for (const task of tasks) {
    result[task.id] = asStringList(record?.[task.id] ?? task.acceptance)
  }
  if (record) {
    for (const [key, item] of Object.entries(record)) {
      if (!(key in result)) result[key] = asStringList(item)
    }
  }
  return result
}

/** 在 agent 输出进入 implement 前完成唯一的结构化边界校验与归一化。 */
export function normalizeWorkflowPlan(value: unknown, fallbackGoal = ''): WorkflowPlan | null {
  const record = asRecord(value)
  if (!record || !Array.isArray(record.tasks)) return null

  const tasks = record.tasks
    .map((task, index) => normalizeTask(task, index))
    .filter((task): task is PlanTask => task !== null)
  if (tasks.length === 0 || new Set(tasks.map((task) => task.id)).size !== tasks.length) return null

  const ids = new Set(tasks.map((task) => task.id))
  if (tasks.some((task) => task.dependsOn.some((dependency) => !ids.has(dependency)))) return null
  if (hasCycle(tasks)) return null

  const goal = asString(record.goal) ?? asString(record.objective) ?? fallbackGoal.trim()
  if (!goal) return null
  return {
    version: asVersion(record.version),
    goal,
    constraints: asStringList(record.constraints),
    nonGoals: asStringList(record.nonGoals ?? record.non_goals),
    repositoryFacts: asStringList(record.repositoryFacts ?? record.repository_facts),
    changeScope: asStringList(record.changeScope ?? record.change_scope),
    tasks,
    acceptanceMap: normalizeAcceptanceMap(record.acceptanceMap ?? record.acceptance_map, tasks),
    verificationChecklist: asStringList(record.verificationChecklist ?? record.verification_checklist),
    risks: asStringList(record.risks)
  }
}

function buildPrompt(
  request: string,
  brainstorm: BrainstormResult | null,
  activePlan: ActivePlanDocument | undefined
): string {
  const lines = [
    '你负责 compose workflow 的 plan 阶段。',
    '请返回一个符合 WorkflowPlan 结构的 JSON 对象；每个任务必须有唯一 id、title、dependsOn 和 acceptance。',
    'dependsOn 只能引用当前 tasks 中存在的 id；没有依赖时必须返回空数组。不要创建环，也不要把不确定的依赖留在文本中。',
    '任务应足够独立，使无依赖任务可以在同一批次并行；acceptance 要可验证。',
    '必须填写 goal、constraints、nonGoals、repositoryFacts、changeScope、acceptanceMap、verificationChecklist 和 risks。',
    '',
    `用户请求：\n${request}`
  ]
  if (brainstorm) {
    lines.push('', `brainstorm 结果：\n${JSON.stringify(brainstorm)}`)
  }
  if (activePlan) {
    lines.push(
      '',
      '当前会话已有 active plan。它是用户已经保存的计划事实；本阶段只负责把 Markdown 转成带 dependsOn 的结构化 WorkflowPlan，不要重新发明范围或绕过原计划。',
      `${activePlan.path ? `active plan 路径：${activePlan.path}\n` : ''}${activePlan.content}`
    )
  }
  return lines.join('\n')
}

export async function runPlan(
  host: HostFns,
  request: string,
  brainstorm: BrainstormResult | null,
  autoMode: boolean,
  activePlan?: ActivePlanDocument
): Promise<WorkflowPlan | null> {
  host.progress('plan', 'started')
  let output: AgentResult = null
  try {
    output = await host.agent(buildPrompt(request, brainstorm, activePlan), {
      phase: 'plan',
      isolation: 'shared',
      interactive: !autoMode,
      schema: PLAN_SCHEMA,
      label: activePlan ? 'compose-plan-active' : 'compose-plan'
    })
  } catch {
    output = null
  }

  const plan = normalizeWorkflowPlan(output, request)
  if (!plan) {
    host.progress('plan', 'failed', { message: 'plan 未产出可执行的 WorkflowPlan' })
    return null
  }
  host.progress('plan', 'completed', { message: `计划包含 ${plan.tasks.length} 个任务` })
  return plan
}
