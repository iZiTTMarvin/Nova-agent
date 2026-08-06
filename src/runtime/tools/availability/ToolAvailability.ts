/**
 * 会话级工具组激活态 Owner。
 * enabled=false 时过滤恒等（交互默认无感）；enabled 时仅 core + 已激活组可见。
 */
import type { ChatMessage } from '../../model/types'
import type { ToolDefinition } from '../../model/types'
import {
  getToolGroup,
  isCoreTool,
  isKnownToolGroup,
  listLoadableGroups,
  TOOL_GROUP_MEMBERS,
  type ToolGroupId
} from './toolGroups'

/** load_tools 成功结果中的稳定标记，供跨 turn 从消息历史恢复 */
export const LOAD_TOOLS_ACTIVATED_MARKER = 'tool_group_activated:'

export class ToolAvailability {
  private enabled = false
  private readonly activatedGroups = new Set<ToolGroupId>()

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  isEnabled(): boolean {
    return this.enabled
  }

  getActivatedGroups(): ReadonlySet<ToolGroupId> {
    return this.activatedGroups
  }

  /** 激活组；下一轮 getEffectiveToolDefinitions / isToolAvailable 即可读到 */
  activate(group: string): { ok: true; group: ToolGroupId } | { ok: false; error: string } {
    if (!this.enabled) {
      return { ok: false, error: '工具分组未启用，无法激活工具组' }
    }
    if (!isKnownToolGroup(group)) {
      return {
        ok: false,
        error: `未知工具组 "${group}"。可加载组: ${listLoadableGroups().join(', ')}`
      }
    }
    this.activatedGroups.add(group)
    return { ok: true, group }
  }

  isToolAvailable(toolName: string): boolean {
    if (!this.enabled) return true
    if (isCoreTool(toolName)) return true
    const group = getToolGroup(toolName)
    if (group === null) return true
    return this.activatedGroups.has(group)
  }

  filterDefinitions<T extends { name: string }>(definitions: readonly T[]): T[] {
    if (!this.enabled) {
      // 未启用工具经济时不暴露连接器，其余工具全量可见（交互无感）
      return definitions.filter(def => def.name !== 'load_tools')
    }
    return definitions.filter(def => this.isToolAvailable(def.name))
  }

  /**
   * 从消息历史恢复已激活组。
   * 扫描 assistant.load_tools 调用，并在存在配对 tool 结果时仅计入成功激活。
   */
  restoreFromMessages(messages: readonly ChatMessage[]): void {
    this.activatedGroups.clear()
    const pendingById = new Map<string, string>()

    for (const message of messages) {
      if (message.role === 'assistant' && message.toolCalls) {
        for (const call of message.toolCalls) {
          if (call.name !== 'load_tools') continue
          const group = parseLoadToolsGroupArg(call.arguments)
          if (!group) continue
          if (call.id) {
            pendingById.set(call.id, group)
          }
          // 无 toolCallId 时无法配对结果，跳过
        }
      }

      if (message.role === 'tool' && message.toolCallId) {
        const group = pendingById.get(message.toolCallId)
        if (!group) continue
        pendingById.delete(message.toolCallId)
        const content = typeof message.content === 'string' ? message.content : ''
        if (
          content.includes(`${LOAD_TOOLS_ACTIVATED_MARKER}${group}`) &&
          isKnownToolGroup(group)
        ) {
          this.activatedGroups.add(group)
        }
      }
    }

    // 无配对结果的调用：保守起见不激活（避免失败调用污染状态）
    pendingById.clear()
  }

  /** 生成 load_tools 连接器描述（列出可加载组） */
  buildLoadToolsDescription(): string {
    const lines = [
      '按需激活一组高级工具。激活后下一轮模型请求即可使用该组工具。',
      '可加载组:'
    ]
    for (const group of listLoadableGroups()) {
      const members = TOOL_GROUP_MEMBERS[group]
      const memberText = members.length > 0 ? members.join(', ') : '(reserved, no tools yet)'
      const status = this.activatedGroups.has(group) ? 'activated' : 'available'
      lines.push(`- ${group} [${status}]: ${memberText}`)
    }
    return lines.join('\n')
  }
}

export function filterToolDefinitionsByAvailability(
  definitions: readonly ToolDefinition[],
  availability: ToolAvailability | null | undefined
): ToolDefinition[] {
  if (!availability) return [...definitions]
  return availability.filterDefinitions(definitions)
}

function parseLoadToolsGroupArg(argumentsJson: string): string | null {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const group = (parsed as { group?: unknown }).group
    return typeof group === 'string' && group.trim() ? group.trim() : null
  } catch {
    return null
  }
}
