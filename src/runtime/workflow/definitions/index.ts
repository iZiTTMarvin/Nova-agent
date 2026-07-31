/**
 * 内置 workflow 注册表：`start_workflow` 可选取值的唯一来源。
 *
 * 路由上下文（router/）和 orchestrator 的 startStage 校验都从这里读，
 * 因此新增一条 workflow 只需在 definitions 数组登记，不需要改路由或工具代码。
 */
import type { WorkflowDefinition } from './types'
import { composeWorkflow } from './compose'
import { deepResearchWorkflow } from './deep-research'
import { codeReviewWorkflow } from './code-review'

/**
 * 注入 system prompt 的 workflow 元数据。
 *
 * matchHints 必须在这里出现：模型是靠它区分"改代码"、"查资料"和"审代码"三类请求的，
 * 只给 description 会让语义相近的 workflow 难以分辨。
 */
export interface WorkflowDefinitionMetadata {
  name: string
  description: string
  matchHints: string[]
  /** 允许的起始阶段 */
  stages: string[]
}

const definitions: readonly WorkflowDefinition[] = [
  composeWorkflow,
  deepResearchWorkflow,
  codeReviewWorkflow
]

export function resolveWorkflowDefinition(name: string): WorkflowDefinition | undefined {
  return definitions.find(definition => definition.name === name)
}

export function listWorkflowMetadata(): WorkflowDefinitionMetadata[] {
  return definitions.map(({ name, description, matchHints, stages }) => ({
    name,
    description,
    matchHints: [...matchHints],
    stages: [...stages]
  }))
}

export function listWorkflowDefinitions(): WorkflowDefinition[] {
  return definitions.map(definition => ({
    ...definition,
    matchHints: [...definition.matchHints],
    stages: [...definition.stages]
  }))
}

export type { WorkflowDefinition }
export { composeWorkflow } from './compose'
export { deepResearchWorkflow } from './deep-research'
export { codeReviewWorkflow } from './code-review'
