/**
 * 产品 Tool Catalog：全部内置工具的策略元数据唯一事实源。
 * 新增工具必须在此登记，未登记工具在清洁度校验中 fail closed（不会静默成为 core）。
 */
import type { DeferredToolGroupMeta, ToolCatalogEntry } from './types'

const ENTRIES: readonly ToolCatalogEntry[] = [
  { name: 'ls', capability: 'filesystem-read', exposure: 'always', codeMode: 'nestable-readonly' },
  { name: 'read', capability: 'filesystem-read', exposure: 'always', codeMode: 'nestable-readonly' },
  { name: 'grep', capability: 'filesystem-read', exposure: 'always', codeMode: 'nestable-readonly' },
  { name: 'find', capability: 'filesystem-read', exposure: 'always', codeMode: 'nestable-readonly' },
  { name: 'edit', capability: 'filesystem-write', exposure: 'always', codeMode: 'direct-only' },
  { name: 'write', capability: 'filesystem-write', exposure: 'always', codeMode: 'direct-only' },
  { name: 'bash', capability: 'shell', exposure: 'always', codeMode: 'direct-only' },
  { name: 'shell_session', capability: 'shell', exposure: 'always', codeMode: 'direct-only' },
  { name: 'web_search', capability: 'web', exposure: 'always', codeMode: 'direct-only' },
  {
    name: 'memory_search',
    capability: 'memory',
    exposure: 'always',
    codeMode: 'direct-only',
    registration: 'conditional'
  },
  {
    name: 'code_context',
    capability: 'filesystem-read',
    exposure: 'always',
    codeMode: 'nestable-readonly',
    registration: 'conditional'
  },
  { name: 'archive_read', capability: 'archive', exposure: 'always', codeMode: 'direct-only' },
  {
    name: 'run_code',
    capability: 'filesystem-read',
    exposure: 'always',
    codeMode: 'direct-only',
    registration: 'conditional'
  },
  { name: 'todo_write', capability: 'plan', exposure: 'always', codeMode: 'direct-only' },
  { name: 'askQuestion', capability: 'interaction', exposure: 'always', codeMode: 'direct-only' },
  { name: 'invoke_skill', capability: 'skill', exposure: 'always', codeMode: 'direct-only' },
  { name: 'task', capability: 'agent', exposure: 'deferred', groupId: 'agent', codeMode: 'direct-only' },
  { name: 'save_plan', capability: 'plan', exposure: 'mode-bound', codeMode: 'direct-only' },
  { name: 'switch_mode', capability: 'mode', exposure: 'mode-bound', codeMode: 'direct-only' },
  { name: 'stage_transition', capability: 'compose', exposure: 'mode-bound', codeMode: 'direct-only' },
  { name: 'load_tools', capability: 'internal', exposure: 'internal', codeMode: 'direct-only' }
]

const GROUPS: readonly DeferredToolGroupMeta[] = [
  {
    id: 'agent',
    label: 'agent',
    description: 'Delegate bounded work to child agents and inspect their results.',
    reserved: false
  },
  {
    id: 'browser',
    label: 'browser',
    description: 'Navigate and interact with browser content.',
    reserved: true
  },
  {
    id: 'computer-use',
    label: 'computer-use',
    description: 'Observe and operate desktop applications.',
    reserved: true
  }
]

/**
 * 历史组名兼容 alias：仅恢复旧激活态时归一化，新请求不再向模型暴露。
 */
const GROUP_ALIASES: Readonly<Record<string, string>> = {
  orchestration: 'agent'
}

const entryByName = new Map<string, ToolCatalogEntry>(ENTRIES.map(entry => [entry.name, entry]))
const groupById = new Map<string, DeferredToolGroupMeta>(GROUPS.map(group => [group.id, group]))

/** Catalog 条目只读快照（校验与覆盖测试用），顺序即声明顺序 */
export function listCatalogEntries(): readonly ToolCatalogEntry[] {
  return ENTRIES
}
/** deferred 工具 → 所属组（仅 deferred exposure，非 deferred 一律 null） */
const deferredToolGroup = new Map<string, string>()
for (const entry of ENTRIES) {
  if (entry.exposure === 'deferred' && entry.groupId) {
    deferredToolGroup.set(entry.name, entry.groupId)
  }
}

export function getCatalogEntry(toolName: string): ToolCatalogEntry | null {
  return entryByName.get(toolName) ?? null
}

/** deferred 工具的所属组；非 deferred / 未登记工具返回 null（未登记 ≠ core，fail closed） */
export function getToolGroup(toolName: string): string | null {
  return deferredToolGroup.get(toolName) ?? null
}

/** 是否常驻工具（不随组激活变化）；未登记工具返回 false，由清洁度校验负责拦截 */
export function isCoreTool(toolName: string): boolean {
  const entry = entryByName.get(toolName)
  return entry !== undefined && entry.exposure !== 'deferred'
}

export function getDeferredGroupMeta(groupId: string): DeferredToolGroupMeta | null {
  return groupById.get(groupId) ?? null
}

/** 组内成员（按 Catalog 声明顺序，含未注册成员；空组返回空数组） */
export function listGroupToolNames(groupId: string): readonly string[] {
  if (!groupById.has(groupId)) return []
  const members: string[] = []
  for (const entry of ENTRIES) {
    if (entry.exposure === 'deferred' && entry.groupId === groupId) {
      members.push(entry.name)
    }
  }
  return members
}

/** 全部已定义组 id（含预留空组），按声明顺序稳定输出 */
export function listDefinedGroupIds(): readonly string[] {
  return GROUPS.map(group => group.id)
}

export function isKnownToolGroup(groupId: string): boolean {
  return groupById.has(groupId)
}

/** 可加载组：已定义且非 reserved（reserved 空组不接受 load_tools） */
export function isLoadableToolGroup(groupId: string): boolean {
  const meta = groupById.get(groupId)
  return meta !== undefined && !meta.reserved
}

/** 历史组名归一化：alias → 现行组 id；非 alias 原样返回 */
export function normalizeGroupAlias(groupId: string): string {
  return GROUP_ALIASES[groupId] ?? groupId
}

/**
 * 计算当前宿主的 live deferred 组：组内至少绑定一个已注册成员才对模型暴露。
 * reserved 空组与无注册成员的组绝不进入 load_tools enum / description。
 */
export function listLiveDeferredGroupIds(
  registeredToolNames: Iterable<string>
): readonly string[] {
  const registered = new Set(registeredToolNames)
  const live: string[] = []
  for (const group of GROUPS) {
    if (group.reserved) continue
    const hasMember = listGroupToolNames(group.id).some(name => registered.has(name))
    if (hasMember) live.push(group.id)
  }
  return live
}

/** load_tools 连接器描述（字节级稳定：不嵌入激活状态，只列 live 组） */
export function buildLoadToolsDescription(liveGroupIds: readonly string[]): string {
  const lines = [
    'Load an additional capability group when the current task requires it.',
    'Loaded capabilities become available on the next model step.',
    '',
    'Available groups:'
  ]
  for (const groupId of [...liveGroupIds].sort()) {
    const meta = groupById.get(groupId)
    if (!meta) continue
    lines.push(`- ${meta.id}: ${meta.description}`)
  }
  return lines.join('\n')
}
