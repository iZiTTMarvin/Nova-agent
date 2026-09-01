import { createHash } from 'crypto'
import type { SubagentProfileSnapshot } from '../../shared/subagents'
import { toolHasWriteCapability } from '../../shared/permissions/toolEffects'
import { decodeSubagentProfileFields } from './presetCodec'
import { BUILTIN_SUBAGENT_IDS } from '../../shared/subagents/presetIdentity'

const ARCHIVE_READ_TOOL = 'archive_read'

/**
 * 未显式配置轮数时的默认预算，按 permissionCeiling 分档：可写档需覆盖
 * 「读 → 改 → 跑验证 → 修」循环，只读档单轮效率更高故更短。工程判断而非
 * 测量结果，唯一来源；调用方不得复制分档值。
 */
const DEFAULT_MAX_TOOL_ROUNDS_BY_CEILING = {
  read_only: 40,
  workspace_write: 80
} as const

/**
 * 宿主有 archive_read 时子 Agent 必须继承；宿主明确没有时不得携带。
 * hostHasArchiveRead 未提供时保持 profile 原样，避免装配漏接线误剥能力。
 */
export function applyHostArchiveReadCapability(
  toolNames: readonly string[],
  hostHasArchiveRead: boolean | undefined
): string[] {
  if (hostHasArchiveRead === undefined) {
    return [...toolNames]
  }
  const withoutArchive = toolNames.filter((name) => name !== ARCHIVE_READ_TOOL)
  if (hostHasArchiveRead) {
    return [...withoutArchive, ARCHIVE_READ_TOOL]
  }
  return withoutArchive
}

/**
 * 外部 JSON 只能以 unknown 进入，并在这里一次性归一化为冻结快照。
 * 字段校验规则由 presetCodec 唯一持有；本模块只负责 snapshot 组装。
 */
export function resolveSubagentProfileSnapshot(
  input: unknown,
  expectedProfileId: string,
  options: { readonly allowRecursion?: boolean } = {}
): SubagentProfileSnapshot {
  const parsed = decodeSubagentProfileFields(input)
  if (parsed.id !== expectedProfileId) {
    throw new Error(
      `子代理 profile identity 冲突：expected=${expectedProfileId}, actual=${parsed.id}`
    )
  }

  const permissionCeiling =
    parsed.id === BUILTIN_SUBAGENT_IDS.explore ||
    !parsed.allowedTools.some((name) => toolHasWriteCapability(name))
      ? 'read_only'
      : 'workspace_write'
  const toolNames = parsed.allowedTools.filter((name) => {
    // 递归编排工具默认全部剥离（含续跑），防子代理再派子代理；仅显式 allowRecursion 放行
    if ((name === 'task' || name === 'task_followup') && options.allowRecursion !== true) {
      return false
    }
    return (
      permissionCeiling !== 'read_only' ||
      !toolHasWriteCapability(name)
    )
  })
  const maxToolRounds =
    parsed.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS_BY_CEILING[permissionCeiling]
  const hashInput = {
    profileId: parsed.id,
    name: parsed.name,
    description: parsed.description,
    systemPrompt: parsed.prompt,
    toolNames,
    permissionCeiling,
    model: parsed.model,
    maxToolRounds,
    contextWindow: parsed.contextWindow,
    skillRoots: parsed.skillRoots
  }
  const configHash = createHash('sha256')
    .update(JSON.stringify(hashInput), 'utf8')
    .digest('hex')

  const snapshot: SubagentProfileSnapshot = {
    profileId: parsed.id,
    name: parsed.name,
    description: parsed.description,
    systemPrompt: parsed.prompt,
    toolNames: Object.freeze([...toolNames]),
    permissionCeiling,
    ...(parsed.model ? { model: Object.freeze({ ...parsed.model }) } : {}),
    maxToolRounds,
    ...(parsed.contextWindow !== undefined
      ? { contextWindow: parsed.contextWindow }
      : {}),
    ...(parsed.skillRoots ? { skillRoots: Object.freeze([...parsed.skillRoots]) } : {}),
    configHash
  }
  return Object.freeze(snapshot)
}
