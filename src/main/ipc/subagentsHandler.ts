import { handle } from './secureIpc'
import {
  SUBAGENTS_LIST,
  SUBAGENTS_CREATE,
  SUBAGENTS_UPDATE,
  SUBAGENTS_SET_ENABLED,
  SUBAGENTS_DELETE
} from '../../shared/ipc/channels'
import { BUILTIN_SUBAGENTS } from '../../runtime/agent'
import {
  createPreset,
  deletePreset,
  getPresetFilePath,
  listCustomPresetView,
  setPresetEnabled,
  updatePreset
} from '../../runtime/subagents'
import type { SubAgentSpec, SubagentPresetLocation } from '../../shared/settings/types'
import type {
  SubagentListItem,
  SubagentsListParams,
  SubagentsListResult,
  SubagentPresetCreateParams,
  SubagentPresetUpdateParams,
  SubagentPresetSetEnabledParams,
  SubagentsDeleteParams
} from '../../shared/settings/types'

function toListItem(
  preset: SubAgentSpec,
  origin: SubagentListItem['origin'],
  filePath?: string
): SubagentListItem {
  return {
    ...preset,
    builtin: origin === 'builtin',
    origin,
    ...(filePath ? { filePath } : {})
  }
}

/** 合并视图按稳定 ID 去重：同 ID 的自定义覆盖（含误配）优先展示，内置兜底。 */
function listAllSubagents(workspaceRoot?: string | null): SubagentsListResult {
  const { presets, diagnostics } = listCustomPresetView(workspaceRoot)
  const ids = new Set<string>()
  const items: SubagentListItem[] = []
  for (const entry of presets) {
    ids.add(entry.preset.id)
    items.push(toListItem(entry.preset, entry.location, entry.filePath))
  }
  for (const builtin of BUILTIN_SUBAGENTS) {
    if (ids.has(builtin.id)) continue
    items.push(toListItem(builtin, 'builtin'))
  }
  return {
    items: items.sort((a, b) => a.name.localeCompare(b.name)),
    diagnostics
  }
}

/** 命令结果与 list 行形状一致：location 即写入层级，路径由存储 Owner 提供。 */
function itemForCommandResult(
  preset: SubAgentSpec,
  location: SubagentPresetLocation,
  workspaceRoot?: string | null
): SubagentListItem {
  return toListItem(preset, location, getPresetFilePath(location, workspaceRoot))
}

export function registerSubagentsHandler(): void {
  handle(SUBAGENTS_LIST, async (_event, params: SubagentsListParams = {}): Promise<SubagentsListResult> => {
    return listAllSubagents(params.workspaceRoot)
  })

  handle(SUBAGENTS_CREATE, async (_event, params: SubagentPresetCreateParams): Promise<SubagentListItem> => {
    const preset = createPreset(params.preset, params.location, params.workspaceRoot ?? null)
    return itemForCommandResult(preset, params.location, params.workspaceRoot ?? null)
  })

  handle(SUBAGENTS_UPDATE, async (_event, params: SubagentPresetUpdateParams): Promise<SubagentListItem> => {
    const preset = updatePreset(params.id, params.preset, params.location, params.workspaceRoot ?? null)
    return itemForCommandResult(preset, params.location, params.workspaceRoot ?? null)
  })

  handle(SUBAGENTS_SET_ENABLED, async (_event, params: SubagentPresetSetEnabledParams): Promise<SubagentListItem> => {
    const preset = setPresetEnabled(
      params.id,
      params.enabled,
      params.location,
      params.workspaceRoot ?? null
    )
    return itemForCommandResult(preset, params.location, params.workspaceRoot ?? null)
  })

  handle(SUBAGENTS_DELETE, async (_event, params: SubagentsDeleteParams): Promise<void> => {
    // 内置拒绝在 preset 领域边界完成（SubagentPresetCommandError: builtin_readonly），
    // 这里不做第二次判断。
    deletePreset(params.id, params.location, params.workspaceRoot ?? null)
  })
}
