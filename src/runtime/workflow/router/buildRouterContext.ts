import { readPlanDocumentInWorkspace, isReadablePlanInWorkspace } from '../../plans'
import type { ActivePlanRef } from '../../plans'
import { listWorkflowMetadata, type WorkflowDefinitionMetadata } from '../definitions'

const MAX_PLAN_SUMMARY_CHARS = 4_000
const MAX_PLAN_SUMMARY_LINES = 12

export interface RouterContext {
  hasActivePlan: boolean
  planPath: string | null
  planSummary: string | null
  availableWorkflows: WorkflowDefinitionMetadata[]
}

export interface BuildRouterContextInput {
  workspaceRoot: string
  activePlan?: Pick<ActivePlanRef, 'path'>
}

function summarizePlan(content: string): string | null {
  const summary = content
    .split(/\r?\n/u)
    .slice(0, MAX_PLAN_SUMMARY_LINES)
    .join('\n')
    .trim()
  if (!summary) return null
  return summary.length > MAX_PLAN_SUMMARY_CHARS
    ? `${summary.slice(0, MAX_PLAN_SUMMARY_CHARS - 1)}…`
    : summary
}

export function buildRouterContext(input: BuildRouterContextInput): RouterContext {
  const planPath = isReadablePlanInWorkspace(input.workspaceRoot, input.activePlan?.path)
    ? input.activePlan?.path ?? null
    : null
  const planSummary = planPath
    ? summarizePlan(readPlanDocumentInWorkspace(input.workspaceRoot, planPath) ?? '')
    : null

  return {
    hasActivePlan: planPath !== null,
    planPath,
    planSummary,
    availableWorkflows: listWorkflowMetadata()
  }
}

export function renderRouterContext(context: RouterContext): string {
  const planLines = context.hasActivePlan
    ? [
        `当前 active plan: ${context.planPath ?? '未知'}`,
        context.planSummary ? `计划摘要:\n${context.planSummary}` : '计划正文当前不可读取。'
      ]
    : ['当前没有可读取的 active plan。']
  const workflowLines = context.availableWorkflows.length > 0
    ? context.availableWorkflows.flatMap(workflow => [
        `- ${workflow.name}: ${workflow.description}；可从 ${workflow.stages.join('、')} 开始`,
        ...(workflow.matchHints.length > 0
          ? [`  适用场景: ${workflow.matchHints.join('；')}`]
          : [])
      ])
    : ['- 当前没有已注册的工作流。']

  return [
    '[编排路由上下文]',
    ...planLines,
    '可用工作流:',
    ...workflowLines,
    '简单请求直接回答或使用普通工具。',
    '深度调研用 invoke_skill（deep-research）或 /deep-research；代码审查用 invoke_skill（code-review）或 /code-review。',
    '复杂多阶段改代码请求才调用 start_workflow，且必须选择已列出的 workflow 与 startStage，并把完整用户请求放入 reason。'
  ].join('\n')
}

