import type { ModelDirectoryResult } from '../../../shared/config'
import type { ToolExecutor } from '../types'

export interface ModelListToolDeps {
  readonly getModelDirectory: () => ModelDirectoryResult
}

export function createModelListTool(deps: ModelListToolDeps): ToolExecutor {
  return {
    name: 'model_list',
    description: 'List a read-only directory of configured models: canonical selector, displayName, provider, aliases, availability, and supported effort; contains no credentials or full ModelConfig.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    executionMode: 'parallel',
    async execute() {
      try {
        return { success: true, output: JSON.stringify(deps.getModelDirectory(), null, 2) }
      } catch (error) {
        return { success: false, output: '', error: error instanceof Error ? error.message : String(error) }
      }
    }
  }
}
