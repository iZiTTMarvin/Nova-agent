import type { SubagentCatalogEntry } from '../../../shared/subagents'
import type { ToolContext, ToolExecutor, ToolResult } from '../types'

export interface AgentListToolDeps {
  readonly getCatalog: () => readonly SubagentCatalogEntry[]
}

/** 返回当前 workspace 可派遣子代理及其模型可用性，不暴露 prompt 或凭据。 */
export function createAgentListTool(deps: AgentListToolDeps): ToolExecutor {
  return {
    name: 'agent_list',
    description: '列出可派遣的子代理预设、绑定模型和当前可用性。优先为专业任务匹配 explore/code/review，混合任务再考虑 general-purpose。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    executionMode: 'parallel',
    async execute(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      try {
        return {
          success: true,
          output: JSON.stringify(deps.getCatalog(), null, 2)
        }
      } catch (error) {
        return {
          success: false,
          output: '',
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }
}
