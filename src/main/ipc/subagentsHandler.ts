/**
 * Subagents 配置 IPC — 内置 + 全局/项目自定义 JSON
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ipcMain } from 'electron'
import { SUBAGENTS_LIST, SUBAGENTS_SAVE, SUBAGENTS_DELETE } from '../../shared/ipc/channels'
import { BUILTIN_SUBAGENTS, type SubAgentSpec } from '../../runtime/agent/SubAgentConfig'
import { getNovaHomeDir } from '../../runtime/settings/novaSettings'
import type {
  SubagentListItem,
  SubagentsListParams,
  SubagentsSaveParams,
  SubagentsDeleteParams
} from '../../shared/settings/types'

const BUILTIN_NAMES = new Set(BUILTIN_SUBAGENTS.map(s => s.name))

function globalSubagentsDir(): string {
  return join(getNovaHomeDir(), 'subagents')
}

function projectSubagentsDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.nova', 'subagents')
}

function loadJsonSpecs(dir: string, origin: 'global' | 'project'): SubagentListItem[] {
  if (!existsSync(dir)) return []
  const result: SubagentListItem[] = []
  try {
    for (const f of readdirSync(dir).filter(file => file.endsWith('.json'))) {
      const filePath = join(dir, f)
      try {
        const spec = JSON.parse(readFileSync(filePath, 'utf-8')) as SubAgentSpec
        if (!spec?.name) continue
        result.push({
          ...spec,
          builtin: false,
          origin,
          filePath
        })
      } catch {
        // 跳过损坏的 JSON
      }
    }
  } catch {
    return []
  }
  return result
}

function listAllSubagents(workspaceRoot?: string | null): SubagentListItem[] {
  const byName = new Map<string, SubagentListItem>()

  // 项目级覆盖全局
  for (const item of loadJsonSpecs(globalSubagentsDir(), 'global')) {
    byName.set(item.name, item)
  }
  if (workspaceRoot) {
    for (const item of loadJsonSpecs(projectSubagentsDir(workspaceRoot), 'project')) {
      byName.set(item.name, item)
    }
  }

  const custom = [...byName.values()]
  const builtins: SubagentListItem[] = BUILTIN_SUBAGENTS.map(s => ({
    ...s,
    builtin: true,
    origin: 'builtin' as const
  }))

  // 自定义同名覆盖内置展示，但内置仍保留若未被覆盖
  const names = new Set<string>()
  const result: SubagentListItem[] = []
  for (const s of [...custom, ...builtins]) {
    if (names.has(s.name)) continue
    names.add(s.name)
    result.push(s)
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/** 校验自定义子代理规格（导出供单测） */
export function validateSpec(spec: SubAgentSpec): void {
  if (!spec.name?.trim()) throw new Error('子代理名称不能为空')
  if (!spec.description?.trim()) throw new Error('子代理描述不能为空')
  if (!Array.isArray(spec.allowedTools)) throw new Error('allowedTools 必须是数组')
  if (!spec.prompt?.trim()) throw new Error('子代理 prompt 不能为空')
  if (BUILTIN_NAMES.has(spec.name)) {
    throw new Error('不能使用与内置子代理相同的名称')
  }
}

export function registerSubagentsHandler(): void {
  ipcMain.handle(SUBAGENTS_LIST, async (_event, params: SubagentsListParams = {}): Promise<SubagentListItem[]> => {
    return listAllSubagents(params.workspaceRoot)
  })

  ipcMain.handle(SUBAGENTS_SAVE, async (_event, params: SubagentsSaveParams): Promise<SubagentListItem> => {
    validateSpec(params.spec)
    const dir =
      params.location === 'project'
        ? params.workspaceRoot
          ? projectSubagentsDir(params.workspaceRoot)
          : null
        : globalSubagentsDir()
    if (!dir) {
      throw new Error('保存项目级子代理需要先打开工作区')
    }
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const filePath = join(dir, `${params.spec.name}.json`)
    writeFileSync(filePath, JSON.stringify(params.spec, null, 2), 'utf-8')
    return {
      ...params.spec,
      builtin: false,
      origin: params.location,
      filePath
    }
  })

  ipcMain.handle(SUBAGENTS_DELETE, async (_event, params: SubagentsDeleteParams): Promise<void> => {
    if (BUILTIN_NAMES.has(params.name)) {
      throw new Error('内置子代理不可删除')
    }
    const candidates = [
      join(globalSubagentsDir(), `${params.name}.json`),
      ...(params.workspaceRoot ? [join(projectSubagentsDir(params.workspaceRoot), `${params.name}.json`)] : [])
    ]
    let deleted = false
    for (const p of candidates) {
      if (existsSync(p)) {
        rmSync(p)
        deleted = true
      }
    }
    if (!deleted) {
      throw new Error('未找到要删除的子代理配置')
    }
  })
}
