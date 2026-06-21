/**
 * SubAgentConfig — 子代理规格与内置/自定义配置加载
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/** 子代理规格 */
export interface SubAgentSpec {
  name: string
  description: string
  allowedTools: string[]
  prompt: string
  model?: { providerID: string; modelID: string }
  maxToolRounds?: number
  contextWindow?: number
}

/** 内置 explore / code 子代理 */
export const BUILTIN_SUBAGENTS: SubAgentSpec[] = [
  {
    name: 'explore',
    description: '只读探索：搜代码、读文件、做调研，不修改任何文件。',
    allowedTools: ['ls', 'read', 'grep', 'find'],
    prompt: `你是一个只读探索助手。分析代码、搜索模式、读文件、做调研。
你不能修改任何文件。完成后用结构化总结回答父 agent 的问题。`,
    maxToolRounds: 20
  },
  {
    name: 'code',
    description: '受限编程：可读、写、跑命令，写操作需父 agent 权限审批。',
    allowedTools: ['ls', 'read', 'grep', 'find', 'edit', 'write', 'bash'],
    prompt: `你是一个受限编程助手。在指定工作区内读、写、执行命令完成任务。
写操作遵守安全边界。完成后返回结构化摘要（改了什么、关键结论）。`,
    maxToolRounds: 30
  }
]

const specByName = new Map(BUILTIN_SUBAGENTS.map(s => [s.name, s]))

/** 按名称获取子代理规格（内置 + 用户自定义） */
export function getSubAgentSpec(name: string, customDir?: string): SubAgentSpec | undefined {
  const custom = loadCustomSubAgents(customDir).find(s => s.name === name)
  return custom ?? specByName.get(name)
}

/** 列出所有可用子代理 */
export function listSubAgents(customDir?: string): SubAgentSpec[] {
  const custom = loadCustomSubAgents(customDir)
  const names = new Set<string>()
  const result: SubAgentSpec[] = []
  for (const s of [...custom, ...BUILTIN_SUBAGENTS]) {
    if (names.has(s.name)) continue
    names.add(s.name)
    result.push(s)
  }
  return result
}

function loadCustomSubAgents(dir?: string): SubAgentSpec[] {
  const subDir = dir ?? join(homedir(), '.nova', 'subagents')
  if (!existsSync(subDir)) return []
  try {
    return readdirSync(subDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          return JSON.parse(readFileSync(join(subDir, f), 'utf-8')) as SubAgentSpec
        } catch {
          return null
        }
      })
      .filter((s): s is SubAgentSpec => s !== null && Boolean(s.name))
  } catch {
    return []
  }
}
