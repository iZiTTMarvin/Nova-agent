import { handle } from './secureIpc'
import { SUBAGENTS_LIST, SUBAGENTS_SAVE, SUBAGENTS_DELETE } from '../../shared/ipc/channels'
import { BUILTIN_SUBAGENTS } from '../../runtime/agent'
import type { SubAgentSpec } from '../../shared/settings/types'
import { deletePreset, getPresetFilePaths, loadMergedCustomPresets, savePreset } from '../../runtime/subagents'
import type {
  SubagentListItem,
  SubagentsListParams,
  SubagentsSaveParams,
  SubagentsDeleteParams
} from '../../shared/settings/types'

const BUILTIN_NAMES = new Set(BUILTIN_SUBAGENTS.map(s => s.name))

function listAllSubagents(workspaceRoot?: string | null): SubagentListItem[] {
  const merged = loadMergedCustomPresets(workspaceRoot)
  const filePaths = getPresetFilePaths()
  const custom: SubagentListItem[] = merged.map(({ spec, origin }) => ({
    ...spec,
    builtin: false,
    origin,
    filePath: origin === 'project' && workspaceRoot ? filePaths.projectFile(workspaceRoot) : filePaths.globalFile
  }))
  const builtins: SubagentListItem[] = BUILTIN_SUBAGENTS.map(s => ({
    ...s,
    builtin: true,
    origin: 'builtin' as const
  }))
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
  handle(SUBAGENTS_LIST, async (_event, params: SubagentsListParams = {}): Promise<SubagentListItem[]> => {
    return listAllSubagents(params.workspaceRoot)
  })

  handle(SUBAGENTS_SAVE, async (_event, params: SubagentsSaveParams): Promise<SubagentListItem> => {
    validateSpec(params.spec)
    savePreset(params.spec, params.location, params.workspaceRoot ?? null)
    const filePaths = getPresetFilePaths()
    const filePath =
      params.location === 'project' && params.workspaceRoot
        ? filePaths.projectFile(params.workspaceRoot)
        : filePaths.globalFile
    return {
      ...params.spec,
      builtin: false,
      origin: params.location,
      filePath
    }
  })

  handle(SUBAGENTS_DELETE, async (_event, params: SubagentsDeleteParams): Promise<void> => {
    if (BUILTIN_NAMES.has(params.name)) {
      throw new Error('内置子代理不可删除')
    }
    const deleted = deletePreset(params.name, params.workspaceRoot ?? null)
    if (!deleted) {
      throw new Error('未找到要删除的子代理配置')
    }
  })
}
