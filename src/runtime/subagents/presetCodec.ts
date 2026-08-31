/**
 * preset 编解码的唯一 Owner：文档版本判定、v1→v2 迁移、字段校验/归一化与
 * 类型化诊断都在这里产生。IPC 保存、磁盘读取与运行时 profile 解析前校验
 * 都收敛到本模块，调用方不得复制规则。
 */
import type { ReasoningEffort } from '../../shared/config/llmRegistry'
import type {
  LegacySubagentModelReference,
  SubagentModelBinding,
  SubagentProfileModel
} from '../../shared/subagents'
import {
  generateSubagentPresetId,
  isBuiltinSubagentId,
  isValidSubagentPresetId
} from '../../shared/subagents/presetIdentity'
import type {
  SubAgentSpec,
  SubagentPresetDiagnostic,
  SubagentPresetLocation
} from '../../shared/settings/types'

const MAX_PRESET_ID_LENGTH = 128
const MAX_PROFILE_NAME_LENGTH = 128
const MAX_DESCRIPTION_LENGTH = 4_096
const MAX_SYSTEM_PROMPT_LENGTH = 65_536
const MAX_TOOL_NAME_LENGTH = 128
const MAX_TOOL_ROUNDS = 1_000

/** 当前持久化文档版本；v1 只允许经 decodePresetDocument 的单一迁移入口读取。 */
const PRESET_DOCUMENT_VERSION = 2

export interface PresetDecodeIssue {
  field?: string
  message: string
}

export class SubagentPresetDecodeError extends Error {
  readonly name = 'SubagentPresetDecodeError'
  constructor(readonly issues: PresetDecodeIssue[]) {
    super(issues.map((issue) => issue.message).join('；'))
  }
}

/** 运行时 profile（含 skill fork 动态形状）的字段归一化结果。 */
export interface SubagentProfileFields {
  id: string
  name: string
  description: string
  prompt: string
  allowedTools: string[]
  model?: SubagentProfileModel
  /** 缺省保持缺省；默认值由 snapshot 构造方决定，避免往返时伪造字段。 */
  maxToolRounds?: number
  contextWindow?: number
  skillRoots?: string[]
}

export interface DecodedPresetLayer {
  presets: SubAgentSpec[]
  diagnostics: SubagentPresetDiagnostic[]
}

/** 从已判定版本的文档中取 revision；缺失或非法按 0 计。 */
export function decodeDocumentRevision(parsed: unknown): number {
  if (!isObject(parsed) || !('revision' in parsed)) return 0
  const revision = (parsed as { revision: unknown }).revision
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0
    ? revision
    : 0
}

/** 校验并归一化单个持久化 preset（当前版本形状：严格 id + 显式 enabled）。 */
export function decodeSubagentPreset(input: unknown): SubAgentSpec {
  const fields = decodeSubagentProfileFields(input)
  if (!isObject(input) || typeof input.enabled !== 'boolean') {
    throw new SubagentPresetDecodeError([
      { field: 'enabled', message: '子代理预设.enabled 必须是 boolean' }
    ])
  }
  if (!isValidSubagentPresetId(fields.id)) {
    throw new SubagentPresetDecodeError([
      {
        field: 'id',
        message:
          '子代理预设.id 必须是 1-64 位小写字母、数字、"."、"_" 或 "-"，且首尾为字母或数字'
      }
    ])
  }
  if (isBuiltinSubagentId(fields.id)) {
    throw new SubagentPresetDecodeError([
      { field: 'id', message: `子代理预设.id「${fields.id}」为内置保留身份，不可占用` }
    ])
  }
  requireCanonicalModelBinding(fields)
  return {
    id: fields.id,
    name: fields.name,
    description: fields.description,
    enabled: input.enabled,
    allowedTools: fields.allowedTools,
    prompt: fields.prompt,
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    ...(fields.maxToolRounds !== undefined
      ? { maxToolRounds: fields.maxToolRounds }
      : {}),
    ...(fields.contextWindow !== undefined
      ? { contextWindow: fields.contextWindow }
      : {})
  }
}

/** 写入路径要求 canonical binding；旧 model 引用只允许经迁移入口只读进入内存。 */
function requireCanonicalModelBinding(fields: SubagentProfileFields): void {
  if (fields.model !== undefined && !('modelEntryId' in fields.model)) {
    throw new SubagentPresetDecodeError([
      {
        field: 'model',
        message: '子代理预设的模型绑定必须是 providerId + modelEntryId，旧 model 引用不可保存'
      }
    ])
  }
}

/**
 * 共享字段校验：id/name/description/prompt/allowedTools/model/数值边界。
 * id 只要求非空且有界（skill fork 的动态 profile 允许冒号等形状）；
 * preset 层的严格 slug 规则由 decodeSubagentPreset 追加。
 */
export function decodeSubagentProfileFields(input: unknown): SubagentProfileFields {
  if (!isObject(input)) {
    throw new SubagentPresetDecodeError([
      { message: '子代理 profile 必须是 JSON object' }
    ])
  }
  const issues: PresetDecodeIssue[] = []
  const id = readRequiredString(input, 'id', MAX_PRESET_ID_LENGTH, issues)
  const name = readRequiredString(input, 'name', MAX_PROFILE_NAME_LENGTH, issues)
  const description = readRequiredString(input, 'description', MAX_DESCRIPTION_LENGTH, issues)
  const prompt = readRequiredString(input, 'prompt', MAX_SYSTEM_PROMPT_LENGTH, issues, false)

  let allowedTools: string[] | undefined
  const allowedToolsValue = input.allowedTools
  if (!Array.isArray(allowedToolsValue)) {
    issues.push({ field: 'allowedTools', message: '子代理 profile.allowedTools 必须是 string[]' })
  } else {
    allowedTools = []
    const seen = new Set<string>()
    for (const value of allowedToolsValue) {
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > MAX_TOOL_NAME_LENGTH
      ) {
        issues.push({
          field: 'allowedTools',
          message: '子代理 profile.allowedTools 包含非法工具名'
        })
        break
      }
      const toolName = value.trim()
      if (!seen.has(toolName)) {
        seen.add(toolName)
        allowedTools.push(toolName)
      }
    }
  }

  const maxToolRounds = readOptionalPositiveInteger(
    input.maxToolRounds,
    'maxToolRounds',
    MAX_TOOL_ROUNDS,
    issues
  )
  const contextWindow = readOptionalPositiveInteger(
    input.contextWindow,
    'contextWindow',
    Number.MAX_SAFE_INTEGER,
    issues
  )

  let skillRoots: string[] | undefined
  if (input.skillRoots !== undefined) {
    if (!Array.isArray(input.skillRoots) || input.skillRoots.length > 16) {
      issues.push({
        field: 'skillRoots',
        message: '子代理 profile.skillRoots 必须是最多 16 项的 string[]'
      })
    } else {
      skillRoots = []
      for (const value of input.skillRoots) {
        if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
          issues.push({ field: 'skillRoots', message: '子代理 profile.skillRoots 包含非法路径' })
          skillRoots = undefined
          break
        }
        const root = value.trim()
        if (!skillRoots.includes(root)) skillRoots.push(root)
      }
    }
  }

  let model: SubagentProfileModel | undefined
  if (input.model !== undefined) {
    try {
      model = parseSubagentModel(input.model)
    } catch (error) {
      issues.push({
        field: 'model',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  if (
    issues.length > 0 ||
    id === undefined ||
    name === undefined ||
    description === undefined ||
    prompt === undefined ||
    allowedTools === undefined
  ) {
    throw new SubagentPresetDecodeError(
      issues.length > 0 ? issues : [{ message: '子代理 profile 必填字段缺失' }]
    )
  }

  return {
    id,
    name,
    description,
    prompt,
    allowedTools,
    ...(maxToolRounds !== undefined ? { maxToolRounds } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(skillRoots ? { skillRoots } : {}),
    ...(model !== undefined ? { model } : {})
  }
}

/**
 * 解析 preset 模型绑定；旧 modelId 形状仅作为只读兼容保留，新写入由
 * decodeSubagentPreset 追加 canonical binding 要求。
 */
function parseSubagentModel(input: unknown): SubagentProfileModel {
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
    const providerId = readNonEmptyString(input.providerId)
    const modelEntryId = readNonEmptyString(input.modelEntryId)
    if (providerId === undefined || modelEntryId === undefined) {
      throw new Error('子代理 profile.model 的新形状必须是 providerId + modelEntryId')
    }
    const reasoningEffort = readOptionalReasoningEffort(input.reasoningEffort)
    return {
      providerId,
      modelEntryId,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
    } satisfies SubagentModelBinding
  }

  const providerId = readNonEmptyString(input.providerID ?? input.providerId)
  const modelId = readNonEmptyString(input.modelID ?? input.modelId)
  if (providerId === undefined || modelId === undefined) {
    throw new Error('子代理 profile.model.providerId/modelId 必须是非空字符串')
  }
  return { providerId, modelId } satisfies LegacySubagentModelReference
}

/**
 * 文档级解码：未知版本与损坏文档 fail closed 并给出类型化诊断；
 * 单条目非法只丢弃该条目并记录诊断，不伪装成「没有配置」。
 */
export function decodePresetDocument(
  parsed: unknown,
  location: SubagentPresetLocation
): DecodedPresetLayer {
  if (!isObject(parsed)) {
    return {
      presets: [],
      diagnostics: [
        {
          code: 'document_unreadable',
          location,
          message: '子代理配置不是可识别的文档结构，已 fail closed'
        }
      ]
    }
  }
  if (!('version' in parsed)) {
    return {
      presets: [],
      diagnostics: [
        {
          code: 'unknown_version',
          location,
          message: '子代理配置缺少可判定的 version，已按未知版本忽略'
        }
      ]
    }
  }
  if (parsed.version === PRESET_DOCUMENT_VERSION) {
    return decodeCurrentDocument(parsed, location)
  }
  if (parsed.version === 1) {
    return decodeLegacyDocument(parsed, location)
  }
  return {
    presets: [],
    diagnostics: [
      {
        code: 'unknown_version',
        location,
        message: `子代理配置版本 ${String(parsed.version)} 无法识别，已 fail closed`
      }
    ]
  }
}

function decodeCurrentDocument(
  doc: Record<string, unknown>,
  location: SubagentPresetLocation
): DecodedPresetLayer {
  if (!Array.isArray(doc.presets)) {
    return {
      presets: [],
      diagnostics: [
        {
          code: 'document_unreadable',
          location,
          message: '子代理配置缺少 presets 数组，已 fail closed'
        }
      ]
    }
  }
  const presets: SubAgentSpec[] = []
  const diagnostics: SubagentPresetDiagnostic[] = []
  const taken = new Set<string>()
  for (const raw of doc.presets) {
    try {
      const preset = decodeSubagentPreset(raw)
      if (taken.has(preset.id)) {
        diagnostics.push({
          code: 'duplicate_id',
          location,
          presetId: preset.id,
          message: `子代理配置存在重复 id「${preset.id}」，仅保留首个`
        })
        continue
      }
      taken.add(preset.id)
      presets.push(preset)
    } catch (error) {
      diagnostics.push(presetDiagnostic(raw, location, error))
    }
  }
  return { presets, diagnostics }
}

function decodeLegacyDocument(
  doc: Record<string, unknown>,
  location: SubagentPresetLocation
): DecodedPresetLayer {
  if (!Array.isArray(doc.presets)) {
    return {
      presets: [],
      diagnostics: [
        {
          code: 'document_unreadable',
          location,
          message: '旧版子代理配置缺少 presets 数组，已 fail closed'
        }
      ]
    }
  }
  return migrateLegacyPresets(doc.presets, location)
}

/** 迁移时占位 id；decode 完成后被派生的稳定 ID 取代。 */
const LEGACY_ID_PLACEHOLDER = '__nova_legacy_migrate__'

/** 旧 `{ name, ... }` 形状 → 当前版本的唯一迁移入口；id 派生对同一文档顺序确定。 */
export function migrateLegacyPresets(
  items: readonly unknown[],
  location: SubagentPresetLocation
): DecodedPresetLayer {
  const presets: SubAgentSpec[] = []
  const diagnostics: SubagentPresetDiagnostic[] = []
  const taken = new Set<string>()
  for (const raw of items) {
    if (!isObject(raw)) {
      diagnostics.push({
        code: 'invalid_preset',
        location,
        message: '旧版子代理条目不是 JSON object，已忽略'
      })
      continue
    }
    if ('id' in raw || 'enabled' in raw) {
      diagnostics.push({
        code: 'invalid_preset',
        location,
        message: 'v1 子代理条目不得携带 id/enabled 字段，已忽略；请用当前版本重写'
      })
      continue
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    try {
      const fields = decodeSubagentProfileFields({ ...raw, id: LEGACY_ID_PLACEHOLDER })
      const preset: SubAgentSpec = {
        id: generateSubagentPresetId(fields.name, taken),
        name: fields.name,
        description: fields.description,
        enabled: true,
        allowedTools: fields.allowedTools,
        prompt: fields.prompt,
        ...(fields.model !== undefined ? { model: fields.model } : {}),
        ...(fields.maxToolRounds !== undefined
          ? { maxToolRounds: fields.maxToolRounds }
          : {}),
        ...(fields.contextWindow !== undefined
          ? { contextWindow: fields.contextWindow }
          : {})
      }
      taken.add(preset.id)
      presets.push(preset)
    } catch (error) {
      diagnostics.push({
        code: 'invalid_preset',
        location,
        ...(name ? { presetId: name } : {}),
        message: presetIssueMessage(error)
      })
    }
  }
  return { presets, diagnostics }
}

export function encodePresetDocument(presets: readonly SubAgentSpec[], revision: number): string {
  return JSON.stringify({ version: PRESET_DOCUMENT_VERSION, revision, presets }, null, 2)
}

function presetDiagnostic(
  raw: unknown,
  location: SubagentPresetLocation,
  error: unknown
): SubagentPresetDiagnostic {
  const presetId =
    isObject(raw) && typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined
  const field =
    error instanceof SubagentPresetDecodeError ? error.issues[0]?.field : undefined
  return {
    code: 'invalid_preset',
    location,
    ...(presetId ? { presetId } : {}),
    ...(field ? { field } : {}),
    message: presetIssueMessage(error)
  }
}

function presetIssueMessage(error: unknown): string {
  if (error instanceof SubagentPresetDecodeError) {
    return error.issues.map((issue) => issue.message).join('；')
  }
  return error instanceof Error ? error.message : String(error)
}

function readNonEmptyString(value: unknown, maxLength = MAX_PROFILE_NAME_LENGTH): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    return undefined
  }
  return value.trim()
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
  issues: PresetDecodeIssue[],
  normalizeWhitespace = true
): string | undefined {
  const field = value[key]
  if (typeof field !== 'string' || !field.trim() || field.length > maxLength) {
    issues.push({
      field: key,
      message: `子代理 profile.${key} 必须是非空字符串且长度不超过 ${maxLength}`
    })
    return undefined
  }
  return normalizeWhitespace ? field.trim() : field
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
  maximum: number,
  issues: PresetDecodeIssue[]
): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    issues.push({ field: key, message: `子代理 profile.${key} 必须是 1..${maximum} 的整数` })
    return undefined
  }
  return value as number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}
