import { handle } from './secureIpc'
import { SUBAGENTS_LIST, SUBAGENTS_SAVE, SUBAGENTS_DELETE } from '../../shared/ipc/channels'
import { BUILTIN_SUBAGENTS } from '../../runtime/agent'
import type { SubAgentSpec } from '../../shared/settings/types'
import { deletePreset, getPresetFilePaths, loadMergedCustomPresets, parseSubagentModel, savePreset } from '../../runtime/subagents'
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

/** 校验自定义子代理规格（导出供单测）；外部 IPC 只以 unknown 进入。 */
export function validateSpec(spec: unknown): asserts spec is SubAgentSpec {
  if (!isRecord(spec)) throw new Error('子代理规格必须是 object')
  if (!isNonEmptyString(spec.name)) throw new Error('子代理名称不能为空')
  if (!isNonEmptyString(spec.description)) throw new Error('子代理描述不能为空')
  if (!Array.isArray(spec.allowedTools)) throw new Error('allowedTools 必须是数组')
  if (!spec.allowedTools.every(isNonEmptyString)) throw new Error('allowedTools 必须是 string[]')
  if (!isNonEmptyString(spec.prompt)) throw new Error('子代理 prompt 不能为空')
  if (spec.model !== undefined) validateModelBinding(spec.model)
  if (spec.maxToolRounds !== undefined && !isPositiveInteger(spec.maxToolRounds)) {
    throw new Error('maxToolRounds 必须是正整数')
  }
  if (spec.contextWindow !== undefined && !isPositiveInteger(spec.contextWindow)) {
    throw new Error('contextWindow 必须是正整数')
  }
  if (BUILTIN_NAMES.has(spec.name)) {
    throw new Error('不能使用与内置子代理相同的名称')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function validateModelBinding(value: unknown): void {
  const model = parseSubagentModel(value)
  if (!('modelEntryId' in model)) {
    throw new Error('旧 model 引用不可保存，请改为 providerId + modelEntryId')
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
