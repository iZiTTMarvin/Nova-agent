/**
 * SubAgentConfig — 内置规格与 dispatcher 侧只读解析
 *
 * 持久化预设的读取/合并/迁移/写入由 runtime/subagents/presetStore 拥有；
 * 本模块只保留内置 definition 与 workspace-scoped 派遣视图。内置 ID 是保留字，
 * 与 shared/subagents/presetIdentity 的 BUILTIN_SUBAGENT_IDS 一一对应。
 */
import { getSubAgentSpecFromStore, listCustomPresets } from '../../subagents'
import { BUILTIN_SUBAGENT_IDS } from '../../../shared/subagents/presetIdentity'
import type { SubAgentSpec } from '../../../shared/settings/types'

export type { SubAgentSpec }

/** 内置子代理；ID 为稳定身份且为保留字，不可改删。 */
export const BUILTIN_SUBAGENTS: SubAgentSpec[] = [
  {
    id: BUILTIN_SUBAGENT_IDS.explore,
    name: 'explore',
    description: '只读探索：搜代码、读文件、做调研，不修改任何文件。',
    enabled: true,
    allowedTools: ['ls', 'read', 'grep', 'find', 'code_context'],
    prompt: `你是一个只读探索助手。分析代码、搜索模式、读文件、做调研。
你不能修改任何文件。完成后用结构化总结回答父 agent 的问题。`
  },
  {
    id: BUILTIN_SUBAGENT_IDS.code,
    name: 'code',
    description: '受限编程：可读、写、跑命令，写操作需父 agent 权限审批。',
    enabled: true,
    allowedTools: ['ls', 'read', 'grep', 'find', 'edit', 'write', 'bash', 'shell_session'],
    prompt: `你是一个受限编程助手。在指定工作区内读、写、执行命令完成任务。
写操作遵守安全边界。完成后返回结构化摘要（改了什么、关键结论）。`
  },
  {
    id: BUILTIN_SUBAGENT_IDS.review,
    name: 'review',
    description: '独立审查：只读检查改动的正确性、范围、架构边界与安全，产出 markdown 审查报告。',
    enabled: true,
    allowedTools: ['ls', 'read', 'grep', 'find', 'code_context'],
    prompt: `你是独立代码审查助手。你不修改任何文件。
根据父 agent 提供的 brief（需求背景、计划位置、改动清单、验证证据）独立审查：正确性、是否严守范围、架构边界与依赖方向、安全与可维护性。
产出 markdown 审查报告：总体结论（通过/不通过）、按严重度分级的问题清单（每条含文件位置与理由）、改进建议。`
  },
  {
    id: BUILTIN_SUBAGENT_IDS.generalPurpose,
    name: 'general-purpose',
    description: '通用混合执行：有界的读写、检索与命令验证，遵循父会话权限与 shared 隔离；不适合纯探索、主要编码或独立审查的场景。',
    enabled: true,
    allowedTools: ['ls', 'read', 'grep', 'find', 'code_context', 'edit', 'write', 'bash', 'shell_session', 'web_search', 'run_code'],
    prompt: `你是通用执行助手，处理不适合纯探索、主要编码或独立审查的有界混合任务。
你可以结合工作区读取、外部检索、必要的文件修改和命令验证来完成任务。
严格遵循父会话的权限与 shared workspace 隔离；不派遣新的子代理，不使用 Skill/Workflow、计划或用户交互工具。
完成后返回结构化摘要：做了什么、关键证据、后续建议。`
  }
]

const specById = new Map(BUILTIN_SUBAGENTS.map(s => [s.id, s]))

/** 按稳定 ID 获取子代理规格；project 同 ID 覆盖 global，禁用项与未知 ID 返回 undefined。 */
export function getSubAgentSpec(profileId: string, workspaceRoot?: string | null): SubAgentSpec | undefined {
  const custom = getSubAgentSpecFromStore(profileId, workspaceRoot)
  if (custom) return custom
  return specById.get(profileId)
}

/** 列出可派遣子代理：启用中的自定义 preset 按稳定 ID 合并，再接内置项。 */
export function listSubAgents(workspaceRoot?: string | null): SubAgentSpec[] {
  const custom = listCustomPresets(workspaceRoot)
  const ids = new Set<string>()
  const result: SubAgentSpec[] = []
  for (const s of [...custom, ...BUILTIN_SUBAGENTS]) {
    if (ids.has(s.id)) continue
    ids.add(s.id)
    result.push(s)
  }
  return result
}
