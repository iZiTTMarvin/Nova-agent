/**
 * SubAgentConfig — 内置规格与运行时预设解析
 *
 * 持久化预设的读取/合并/迁移由 runtime/subagents/presetStore 拥有；
 * 本模块只保留内置 definition 与 dispatcher 侧的 workspace-scoped 解析。
 */
import { getSubAgentSpecFromStore, listCustomPresets } from '../../subagents'
import type { SubAgentSpec } from '../../../shared/settings/types'

export type { SubAgentSpec }

/** 内置 explore / code / review 子代理 */
export const BUILTIN_SUBAGENTS: SubAgentSpec[] = [
  {
    name: 'explore',
    description: '只读探索：搜代码、读文件、做调研，不修改任何文件。',
    allowedTools: ['ls', 'read', 'grep', 'find', 'code_context'],
    prompt: `你是一个只读探索助手。分析代码、搜索模式、读文件、做调研。
你不能修改任何文件。完成后用结构化总结回答父 agent 的问题。`,
    maxToolRounds: 20
  },
  {
    name: 'code',
    description: '受限编程：可读、写、跑命令，写操作需父 agent 权限审批。',
    allowedTools: ['ls', 'read', 'grep', 'find', 'edit', 'write', 'bash', 'shell_session'],
    prompt: `你是一个受限编程助手。在指定工作区内读、写、执行命令完成任务。
写操作遵守安全边界。完成后返回结构化摘要（改了什么、关键结论）。`,
    maxToolRounds: 30
  },
  {
    name: 'review',
    description: '独立审查：只读检查改动的正确性、范围、架构边界与安全，产出 markdown 审查报告。',
    allowedTools: ['ls', 'read', 'grep', 'find', 'code_context'],
    prompt: `你是独立代码审查助手。你不修改任何文件。
根据父 agent 提供的 brief（需求背景、计划位置、改动清单、验证证据）独立审查：正确性、是否严守范围、架构边界与依赖方向、安全与可维护性。
产出 markdown 审查报告：总体结论（通过/不通过）、按严重度分级的问题清单（每条含文件位置与理由）、改进建议。`,
    maxToolRounds: 20
  }
]

const specByName = new Map(BUILTIN_SUBAGENTS.map(s => [s.name, s]))

/** 按名称获取子代理规格，workspaceRoot 存在时优先匹配项目级预设覆盖全局。 */
export function getSubAgentSpec(name: string, workspaceRoot?: string | null): SubAgentSpec | undefined {
  const custom = getSubAgentSpecFromStore(name, workspaceRoot)
  if (custom) return custom
  return specByName.get(name)
}

/** 列出所有可用子代理，custom 按 workspace 合并后与内置去重。 */
export function listSubAgents(workspaceRoot?: string | null): SubAgentSpec[] {
  const custom = listCustomPresets(workspaceRoot)
  const names = new Set<string>()
  const result: SubAgentSpec[] = []
  for (const s of [...custom, ...BUILTIN_SUBAGENTS]) {
    if (names.has(s.name)) continue
    names.add(s.name)
    result.push(s)
  }
  return result
}
