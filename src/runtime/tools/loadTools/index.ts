/**
 * load_tools — 按需激活一个工具组；激活态由 ToolAvailability 拥有。
 */
import type { ToolExecutor, ToolContext, ToolResult } from '../types'
import {
  LOAD_TOOLS_ACTIVATED_MARKER,
  type ToolAvailability,
  listLoadableGroups,
  TOOL_GROUP_MEMBERS
} from '../availability'

export interface LoadToolsDeps {
  getAvailability: () => ToolAvailability | null
}

export function createLoadToolsTool(deps: LoadToolsDeps): ToolExecutor {
  return {
    name: 'load_tools',
    description: buildDescription(deps),
    parameters: {
      type: 'object',
      properties: {
        group: {
          type: 'string',
          description: `要激活的工具组名。可选值: ${listLoadableGroups().join(', ')}`
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
        return {
          success: false,
          output: '',
          error: '工具分组未启用，无法激活工具组'
        }
      }

      const result = availability.activate(group)
      if (!result.ok) {
        return { success: false, output: '', error: result.error }
      }

      const members = TOOL_GROUP_MEMBERS[result.group]
      const memberText =
        members.length > 0 ? members.join(', ') : '(reserved group, no member tools yet)'
      const output = [
        `Activated tool group "${result.group}".`,
        `Members: ${memberText}`,
        `These tools become available on the next model step.`,
        `${LOAD_TOOLS_ACTIVATED_MARKER}${result.group}`
      ].join('\n')

      return { success: true, output }
    }
  }
}

function buildDescription(deps: LoadToolsDeps): string {
  const availability = deps.getAvailability()
  if (availability) {
    return availability.buildLoadToolsDescription()
  }
  return [
    '按需激活一组高级工具。激活后下一轮模型请求即可使用该组工具。',
    `可加载组: ${listLoadableGroups().join(', ')}`
  ].join('\n')
}
