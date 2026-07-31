import type { WorkflowDefinition } from './types'
import { composeWorkflow } from './compose'

export interface WorkflowDefinitionMetadata {
  name: string
  description: string
  stages: string[]
}

const definitions: readonly WorkflowDefinition[] = [composeWorkflow]

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
export { composeWorkflow } from './compose'
