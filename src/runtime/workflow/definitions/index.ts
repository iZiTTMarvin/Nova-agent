import type { WorkflowDefinition } from './types'

export interface WorkflowDefinitionMetadata {
  name: string
  description: string
  stages: string[]
}

const composeDefinition: WorkflowDefinition = {
  name: 'compose',
  description: '按阶段推进复杂的软件开发请求，并在终态返回摘要。',
  matchHints: ['复杂开发任务', '多阶段实现', '需要计划、实现、验证和审查'],
  stages: ['brainstorm', 'plan', 'implement', 'verify', 'review', 'report'],
  async run() {
    return {
      status: 'failed',
      reason: 'compose 工作流尚未提供可执行定义'
    }
  }
}

const definitions: readonly WorkflowDefinition[] = [composeDefinition]

export function resolveWorkflowDefinition(name: string): WorkflowDefinition | undefined {
  return definitions.find(definition => definition.name === name)
}

export function listWorkflowMetadata(): WorkflowDefinitionMetadata[] {
  return definitions.map(({ name, description, stages }) => ({
    name,
    description,
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

