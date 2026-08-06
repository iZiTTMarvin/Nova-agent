/**
 * 工具自然能力簇：未列入任何可加载组的工具视为 core（始终可见）。
 * browser / computer-use 预留空组，供后续工具挂载。
 */

export type ToolGroupId =
  | 'web'
  | 'memory'
  | 'orchestration'
  | 'workflow'
  | 'browser'
  | 'computer-use'

export const LOADABLE_TOOL_GROUPS: readonly ToolGroupId[] = [
  'web',
  'memory',
  'orchestration',
  'workflow',
  'browser',
  'computer-use'
] as const

/** 组 → 成员工具名 */
export const TOOL_GROUP_MEMBERS: Readonly<Record<ToolGroupId, readonly string[]>> = {
  web: ['web_search'],
  memory: ['memory_search'],
  orchestration: ['task', 'invoke_skill'],
  workflow: ['start_workflow'],
  browser: [],
  'computer-use': []
}

/** 始终属于 core 的工具（含连接器本身） */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ls',
  'read',
  'grep',
  'find',
  'edit',
  'write',
  'bash',
  'archive_read',
  'todo_write',
  'askQuestion',
  'save_plan',
  'switch_mode',
  'load_tools'
])

const TOOL_TO_GROUP = new Map<string, ToolGroupId>()
for (const group of LOADABLE_TOOL_GROUPS) {
  for (const toolName of TOOL_GROUP_MEMBERS[group]) {
    TOOL_TO_GROUP.set(toolName, group)
  }
}

export function getToolGroup(toolName: string): ToolGroupId | null {
  return TOOL_TO_GROUP.get(toolName) ?? null
}

export function isCoreTool(toolName: string): boolean {
  return CORE_TOOL_NAMES.has(toolName) || getToolGroup(toolName) === null
}

export function isKnownToolGroup(group: string): group is ToolGroupId {
  return (LOADABLE_TOOL_GROUPS as readonly string[]).includes(group)
}

export function listLoadableGroups(): readonly ToolGroupId[] {
  return LOADABLE_TOOL_GROUPS
}
