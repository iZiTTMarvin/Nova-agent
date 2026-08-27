import { createHash } from 'crypto'
import type {
  LegacySubagentModelReference,
  SubagentModelBinding,
  SubagentProfileModel,
  SubagentProfileSnapshot
} from '../../shared/subagents'
import type { ReasoningEffort } from '../../shared/config/llmRegistry'
import { toolHasWriteCapability } from '../../shared/permissions/toolEffects'

const MAX_PROFILE_NAME_LENGTH = 128
const MAX_DESCRIPTION_LENGTH = 4_096
const MAX_SYSTEM_PROMPT_LENGTH = 65_536
const MAX_TOOL_NAME_LENGTH = 128
const MAX_TOOL_ROUNDS = 1_000
const ARCHIVE_READ_TOOL = 'archive_read'

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

interface ParsedSubagentProfile {
  name: string
  description: string
  allowedTools: string[]
  prompt: string
  model?: SubagentProfileModel
  maxToolRounds: number
  contextWindow?: number
  skillRoots?: string[]
}

/** 外部 JSON 只能以 unknown 进入，并在这里一次性归一化为冻结快照。 */
export function resolveSubagentProfileSnapshot(
  input: unknown,
  expectedProfileId: string,
  options: { readonly allowRecursion?: boolean } = {}
): SubagentProfileSnapshot {
  const parsed = parseSubagentProfile(input)
  if (parsed.name !== expectedProfileId) {
    throw new Error(
      `子代理 profile identity 冲突：expected=${expectedProfileId}, actual=${parsed.name}`
    )
  }

  const permissionCeiling =
    parsed.name === 'explore' ||
    !parsed.allowedTools.some((name) => toolHasWriteCapability(name))
      ? 'read_only'
      : 'workspace_write'
  const toolNames = parsed.allowedTools.filter((name) => {
    if (name === 'task' && options.allowRecursion !== true) return false
    return (
      permissionCeiling !== 'read_only' ||
      !toolHasWriteCapability(name)
    )
  })
  const hashInput = {
    profileId: parsed.name,
    name: parsed.name,
    description: parsed.description,
    systemPrompt: parsed.prompt,
    toolNames,
    permissionCeiling,
    model: parsed.model,
    maxToolRounds: parsed.maxToolRounds,
    contextWindow: parsed.contextWindow,
    skillRoots: parsed.skillRoots
  }
  const configHash = createHash('sha256')
    .update(JSON.stringify(hashInput), 'utf8')
    .digest('hex')

  const snapshot: SubagentProfileSnapshot = {
    profileId: parsed.name,
    name: parsed.name,
    description: parsed.description,
    systemPrompt: parsed.prompt,
    toolNames: Object.freeze([...toolNames]),
    permissionCeiling,
    ...(parsed.model ? { model: Object.freeze({ ...parsed.model }) } : {}),
    maxToolRounds: parsed.maxToolRounds,
    ...(parsed.contextWindow !== undefined
      ? { contextWindow: parsed.contextWindow }
      : {}),
    ...(parsed.skillRoots ? { skillRoots: Object.freeze([...parsed.skillRoots]) } : {}),
    configHash
  }
  return Object.freeze(snapshot)
}

function parseSubagentProfile(input: unknown): ParsedSubagentProfile {
  if (!isObject(input)) throw new Error('子代理 profile 必须是 JSON object')
  const name = readString(input, 'name', MAX_PROFILE_NAME_LENGTH)
  const description = readString(input, 'description', MAX_DESCRIPTION_LENGTH)
  const prompt = readString(input, 'prompt', MAX_SYSTEM_PROMPT_LENGTH, false)
  const allowedToolsValue = input.allowedTools
  if (!Array.isArray(allowedToolsValue)) {
    throw new Error('子代理 profile.allowedTools 必须是 string[]')
  }
  const allowedTools: string[] = []
  const seen = new Set<string>()
  for (const value of allowedToolsValue) {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > MAX_TOOL_NAME_LENGTH
    ) {
      throw new Error('子代理 profile.allowedTools 包含非法工具名')
    }
    const toolName = value.trim()
    if (!seen.has(toolName)) {
      seen.add(toolName)
      allowedTools.push(toolName)
    }
  }

  const maxToolRounds = readOptionalPositiveInteger(
    input.maxToolRounds,
    'maxToolRounds',
    20,
    MAX_TOOL_ROUNDS
  )
  const contextWindow =
    input.contextWindow === undefined
      ? undefined
      : readOptionalPositiveInteger(
          input.contextWindow,
          'contextWindow',
          1,
          Number.MAX_SAFE_INTEGER
        )

  let skillRoots: string[] | undefined
  if (input.skillRoots !== undefined) {
    if (!Array.isArray(input.skillRoots) || input.skillRoots.length > 16) {
      throw new Error('子代理 profile.skillRoots 必须是最多 16 项的 string[]')
    }
    skillRoots = []
    for (const value of input.skillRoots) {
      if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
        throw new Error('子代理 profile.skillRoots 包含非法路径')
      }
      const root = value.trim()
      if (!skillRoots.includes(root)) skillRoots.push(root)
    }
  }

  let model: ParsedSubagentProfile['model']
  if (input.model !== undefined) {
    model = parseSubagentModel(input.model)
  }

  return {
    name,
    description,
    prompt,
    allowedTools,
    maxToolRounds,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(skillRoots ? { skillRoots } : {}),
    ...(model ? { model } : {})
  }
}

/** 统一解析 preset/profile 的模型字段；旧 modelId 形状只作为只读兼容保留。 */
export function parseSubagentModel(input: unknown): SubagentProfileModel {
  if (!isObject(input)) throw new Error('子代理 profile.model 必须是 object')
  if (hasOwn(input, 'modelEntryId')) {
    if (
      !hasOwn(input, 'providerId') ||
      hasOwn(input, 'providerID') ||
      hasOwn(input, 'modelID') ||
      hasOwn(input, 'modelId')
    ) {
      throw new Error('子代理 profile.model 的新形状必须是 providerId + modelEntryId')
    }
    const providerId = readString(input, 'providerId', MAX_PROFILE_NAME_LENGTH)
    const modelEntryId = readString(input, 'modelEntryId', MAX_PROFILE_NAME_LENGTH)
    const reasoningEffort = readOptionalReasoningEffort(input.reasoningEffort)
    return {
      providerId,
      modelEntryId,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
    } satisfies SubagentModelBinding
  }

  const providerId = readAliasedString(input, 'providerID', 'providerId')
  const modelId = readAliasedString(input, 'modelID', 'modelId')
  return { providerId, modelId } satisfies LegacySubagentModelReference
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
  normalizeWhitespace = true
): string {
  const field = value[key]
  if (typeof field !== 'string' || !field.trim() || field.length > maxLength) {
    throw new Error(`子代理 profile.${key} 必须是非空字符串且长度不超过 ${maxLength}`)
  }
  return normalizeWhitespace ? field.trim() : field
}

function readAliasedString(
  value: Record<string, unknown>,
  first: string,
  second: string
): string {
  const field = value[first] ?? value[second]
  if (typeof field !== 'string' || !field.trim()) {
    throw new Error(`子代理 profile.model.${first}/${second} 必须是非空字符串`)
  }
  return field.trim()
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function readOptionalReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined) return undefined
  if (
    value !== 'auto' &&
    value !== 'low' &&
    value !== 'medium' &&
    value !== 'high' &&
    value !== 'max'
  ) {
    throw new Error('子代理 profile.model.reasoningEffort 必须是 auto/low/medium/high/max')
  }
  return value
}

function readOptionalPositiveInteger(
  value: unknown,
  key: string,
  fallback: number,
  maximum: number
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error(`子代理 profile.${key} 必须是 1..${maximum} 的整数`)
  }
  return value as number
}
