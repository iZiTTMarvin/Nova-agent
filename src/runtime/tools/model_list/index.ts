import type { ModelDirectoryResult } from '../../../shared/config'
import type { ToolExecutor } from '../types'

export interface ModelListToolDeps {
  readonly getModelDirectory: () => ModelDirectoryResult
}

export function createModelListTool(deps: ModelListToolDeps): ToolExecutor {
  return {
    name: 'model_list',
    description: '列出已配置模型的只读目录：canonical selector、displayName、provider、aliases、可用性与支持的 effort；不含凭据与完整 ModelConfig。',
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
