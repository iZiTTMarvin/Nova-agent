/**
 * load_tools — 按需激活一个 live deferred 组；激活态由 ToolAvailability 拥有。
 * enum 与描述在创建时从 Catalog + 注册清单派生，字节级稳定；
 * 全部组已加载后连接器保持在场并返回 already_loaded，避免 request shape 抖动。
 */
import type { ToolExecutor, ToolContext, ToolResult } from '../types'
import {
  LOAD_TOOLS_ACTIVATED_MARKER,
  formatToolEconomyActivationLog,
  type ToolAvailability
} from '../availability'
import {
  buildLoadToolsDescription,
  listGroupToolNames,
  listLiveDeferredGroupIds
} from '../catalog'

export interface LoadToolsDeps {
  getAvailability: () => ToolAvailability | null
  /** 创建时已完成的注册清单；live 组 enum / 描述的唯一来源 */
  registeredToolNames: readonly string[]
}

export function createLoadToolsTool(deps: LoadToolsDeps): ToolExecutor {
  const groupEnum = [...listLiveDeferredGroupIds(deps.registeredToolNames)].sort()
  const description = buildLoadToolsDescription(groupEnum)

  return {
    name: 'load_tools',
    description,
    parameters: {
      type: 'object',
      properties: {
        group: {
          type: 'string',
          enum: groupEnum,
          description: `Capability group to load. Allowed values: ${groupEnum.join(', ')}`
        }
      },
      required: ['group'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      const group = typeof args.group === 'string' ? args.group.trim() : ''
      if (!group) {
        return { success: false, output: '', error: '缺少参数 group' }
      }

      const availability = deps.getAvailability()
      if (!availability) {
        return { success: false, output: '', error: '工具经济未启用，无法激活工具组' }
      }

      const previousActive = availability.getActiveToolNames().length
      const result = availability.activate(group)
      if (!result.ok) {
        return { success: false, output: '', error: result.error }
      }

      const members = listGroupToolNames(result.group)
      const nextActive = availability.getActiveToolNames().length
      console.log(
        formatToolEconomyActivationLog({
          group: result.group,
          reason: 'model',
          previousActive,
          nextActive,
          outcome: result.alreadyActive ? 'already_loaded' : 'success'
        })
      )

      const output = result.alreadyActive
        ? [
            `Tool group "${result.group}" is already loaded.`,
            `Members: ${members.join(', ')}`,
            `${LOAD_TOOLS_ACTIVATED_MARKER}${result.group}`
          ].join('\n')
        : [
            `Activated tool group "${result.group}".`,
            `Members: ${members.join(', ')}`,
            `These tools become available on the next model step.`,
            `${LOAD_TOOLS_ACTIVATED_MARKER}${result.group}`
          ].join('\n')

      return { success: true, output }
    }
  }
}
