/**
 * 记忆域工具名单的单一来源。
 * 记忆工具自身的输出禁止反哺记忆：不作为证据、不作为 observation、不作为提炼输入；
 * 名单扩张时只改这里。
 */
export const MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set(['memory_search', 'memory_manage'])
