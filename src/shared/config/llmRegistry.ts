/**
 * LLM 多服务商注册表 — 类型、预设、解析与迁移
 *
 * version 2 配置结构：多个服务商，每个服务商下多个模型；
 * 运行时通过 resolveModelConfig 合并为 OpenAI 兼容 ModelConfig。
 */
import type { ModelConfig, ModelRouteRef, ReasoningEffort } from './types'
import { lookupModelCapability } from './modelRegistry'
export type { ReasoningEffort } from './types'

/** 预设服务商 ID */
export type PresetProviderId = 'minimax' | 'glm' | 'deepseek'

/** 活跃模型引用（provider + model entry）；与运行时路由身份共用同一形状 */
export type ActiveModelRef = ModelRouteRef

/** 服务商下的单个模型条目 */
export interface ModelEntry {
  /** 本地稳定 ID */
  id: string
  /** API 模型标识 */
  modelId: string
  displayName?: string
  /** 显式别名：仅规范化后的精确匹配参与自然语言解析，不做编辑距离猜测。 */
  aliases?: string[]
  contextWindow?: number
  supportsVision?: boolean
  /** 思考强度；缺省或 'auto' 时不发送 reasoning 参数 */
  reasoningEffort?: ReasoningEffort
  /** 已退役模型不得用于新执行，但历史 header 可继续解释。 */
  retired?: boolean
}

/** 服务商配置 */
export interface ProviderConfig {
  connectionRevision?: string
  id: string
  name: string
  /** 预设服务商标记；自定义服务商无此字段 */
  presetId?: PresetProviderId
  baseUrl: string
  apiKey: string
  enabled: boolean
  models: ModelEntry[]
  toolDialect?: 'auto' | 'native' | 'xml'
}

/** LLM 注册表（持久化 v2 格式） */
export interface LlmRegistry {
  version: 2
  providers: ProviderConfig[]
  activeModel: ActiveModelRef
  /** 备用模型引用链（错误降级用） */
  fallbacks?: ActiveModelRef[]
}

/** 预设服务商元数据 */
export interface PresetProviderMeta {
  presetId: PresetProviderId
  name: string
  baseUrl: string
  defaultModels: Array<{
    modelId: string
    displayName?: string
    /** 显式视觉能力；未设时由 inferVisionSupport(modelId) 推断 */
    supportsVision?: boolean
    /**
     * 显式上下文窗口；未设时由 resolveContextWindow(modelId) 推断。
     * DeepSeek 等可为 Nova 工程上限（非官方规格），见 modelRegistry 注释。
     */
    contextWindow?: number
  }>
}

/** 三个内置预设服务商 */
export const PRESET_PROVIDERS: Record<PresetProviderId, PresetProviderMeta> = {
  minimax: {
    presetId: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultModels: [
      // 官方 204,800（platform.minimax.io，验证 2026-07）
      { modelId: 'MiniMax-M2.5', displayName: 'MiniMax-M2.5', contextWindow: 204_800 },
      {
        modelId: 'MiniMax-M2.5-highspeed',
        displayName: 'MiniMax-M2.5-highspeed',
        contextWindow: 204_800
      }
    ]
  },
  glm: {
    presetId: 'glm',
    name: 'GLM',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    defaultModels: [
      // 默认 API 窗口未单独核实（有 [1m] 变体），留空走兜底（2026-07）
      { modelId: 'glm-5.2', displayName: 'GLM-5.2' },
      { modelId: 'glm-5.1', displayName: 'GLM-5.1' }
    ]
  },
  deepseek: {
    presetId: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModels: [
      // 官方规格 1M；Nova 配置 500K 以控制 KV cache 成本与延迟，Agent 场景绰绰有余（2026-07）
      {
        modelId: 'deepseek-v4-flash',
        displayName: 'deepseek-v4-flash',
        supportsVision: false,
        contextWindow: 500_000
      },
      {
        modelId: 'deepseek-v4-pro',
        displayName: 'deepseek-v4-pro',
        supportsVision: false,
        contextWindow: 500_000
      }
    ]
  }
}

export const PRESET_PROVIDER_IDS: PresetProviderId[] = ['minimax', 'glm', 'deepseek']

/** 生成本地唯一 ID */
export function generateLocalId(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** 从预设创建服务商配置（填 Key 即用） */
export function createProviderFromPreset(
  presetId: PresetProviderId,
  apiKey: string,
  existingId?: string
): ProviderConfig {
  const meta = PRESET_PROVIDERS[presetId]
  return {
    id: existingId ?? generateLocalId(presetId),
    name: meta.name,
    presetId,
    baseUrl: meta.baseUrl,
    apiKey: apiKey.trim(),
    enabled: true,
    models: meta.defaultModels.map(m => ({
      id: generateLocalId('model'),
      modelId: m.modelId,
      displayName: m.displayName,
      ...(m.supportsVision !== undefined ? { supportsVision: m.supportsVision } : {}),
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {})
    })),
    toolDialect: 'auto'
  }
}

/** 创建空白自定义服务商 */
export function createCustomProvider(name: string, baseUrl: string): ProviderConfig {
  return {
    id: generateLocalId('custom'),
    name: name.trim() || '自定义',
    baseUrl: baseUrl.trim() || 'http://localhost:11434/v1',
    apiKey: '',
    enabled: true,
    models: [],
    toolDialect: 'auto'
  }
}

/** 在注册表中查找 provider */
export function findProvider(registry: LlmRegistry, providerId: string): ProviderConfig | undefined {
  return registry.providers.find(p => p.id === providerId)
}

/** 在 provider 中查找 model entry */
export function findModelEntry(provider: ProviderConfig, modelEntryId: string): ModelEntry | undefined {
  return provider.models.find(m => m.id === modelEntryId)
}

/**
 * 计算保存某个服务商后，registry 应使用的 activeModel 引用。
 *
 * 触发锚定到 savingProvider 首个模型的两种情况：
 *   1. 当前 activeModel 指向的 provider 已不在 nextProviders 中
 *      —— 首次配置（activeModel 为空）、provider 被删除、id 漂移均归此列；
 *   2. 当前 activeModel 正指向本次保存的服务商（含 preset 占位 id `preset-<id>`）。
 * 其余情况 activeModel 仍有效，保持不变。
 *
 * 调用方需保证 savingProvider.models 非空（保存前已校验）。
 */
export function resolveActiveModelAfterSave(
  currentActive: ActiveModelRef,
  savingProvider: ProviderConfig,
  nextProviders: ProviderConfig[]
): ActiveModelRef {
  const currentStillExists = nextProviders.some(p => p.id === currentActive.providerId)
  const savingIsActive =
    currentActive.providerId === savingProvider.id ||
    (!!savingProvider.presetId &&
      currentActive.providerId === `preset-${savingProvider.presetId}`)

  if (!currentStillExists || savingIsActive) {
    return { providerId: savingProvider.id, modelEntryId: savingProvider.models[0]!.id }
  }
  return currentActive
}

/**
 * 将 ActiveModelRef 解析为运行时 ModelConfig。
 * provider 未启用、缺 key、模型不存在时返回 null。
 */
export function resolveModelConfig(
  registry: LlmRegistry,
  ref?: ActiveModelRef
): ModelConfig | null {
  const resolved = resolveModelReference(registry, ref)
  return resolved.status === 'available' ? resolved.config : null
}

/** 模型引用不可用的原因，供派生前失败与只读 catalog 复用。 */
export type ModelResolutionStatus =
  | 'available'
  | 'provider_missing'
  | 'provider_disabled'
  | 'credentials_missing'
  | 'model_missing'
  | 'model_retired'
  | 'model_invalid'

export type ModelResolutionResult =
  | {
      readonly status: 'available'
      readonly provider: ProviderConfig
      readonly entry: ModelEntry
      readonly config: ModelConfig
    }
  | {
      readonly status: Exclude<ModelResolutionStatus, 'available'>
      readonly provider?: ProviderConfig
      readonly entry?: ModelEntry
    }

/**
 * 按稳定 providerId + modelEntryId 解析模型。
 * 与 resolveModelConfig 的 null 兼容 API 分开保留原因，避免 missing/retired 混淆。
 */
export function resolveModelReference(
  registry: LlmRegistry,
  ref?: ActiveModelRef
): ModelResolutionResult {
  const target = ref ?? registry.activeModel
  const provider = findProvider(registry, target.providerId)
  if (!provider) return { status: 'provider_missing' }
  if (!provider.enabled) return { status: 'provider_disabled', provider }

  const entry = findModelEntry(provider, target.modelEntryId)
  if (!entry) return { status: 'model_missing', provider }
  if (entry.retired === true) return { status: 'model_retired', provider, entry }

  const apiKey = provider.apiKey.trim()
  const baseUrl = provider.baseUrl.trim()
  if (!apiKey || !baseUrl) return { status: 'credentials_missing', provider, entry }

  const modelId = entry.modelId.trim()
  if (!modelId) return { status: 'model_invalid', provider, entry }

  return {
    status: 'available',
    provider,
    entry,
    config: {
      baseUrl,
      apiKey,
      modelId,
      routeRef: { providerId: target.providerId, modelEntryId: target.modelEntryId },
      ...(provider.connectionRevision ? { connectionRevision: provider.connectionRevision } : {}),
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.supportsVision !== undefined ? { supportsVision: entry.supportsVision } : {}),
      ...(entry.reasoningEffort && entry.reasoningEffort !== 'auto'
        ? { reasoningEffort: entry.reasoningEffort }
        : {}),
      ...(provider.toolDialect && provider.toolDialect !== 'auto'
        ? { toolDialect: provider.toolDialect }
        : {})
    }
  }
}

/** 解析当前活跃模型配置 */
export function resolveActiveModelConfig(registry: LlmRegistry): ModelConfig | null {
  return resolveModelConfig(registry, registry.activeModel)
}

/** 解析 fallback 链为 ModelConfig 数组 */
export function resolveFallbackModelConfigs(registry: LlmRegistry): ModelConfig[] {
  if (!registry.fallbacks?.length) return []
  const result: ModelConfig[] = []
  for (const ref of registry.fallbacks) {
    const cfg = resolveModelConfig(registry, ref)
    if (cfg) result.push(cfg)
  }
  return result
}

/** 获取某预设是否已在注册表中配置 */
export function findProviderByPreset(
  registry: LlmRegistry,
  presetId: PresetProviderId
): ProviderConfig | undefined {
  return registry.providers.find(p => p.presetId === presetId)
}

/** 合并远程拉取的模型 ID 到 provider（去重，保留已有条目） */
export function mergeFetchedModelEntries(
  provider: ProviderConfig,
  remoteModelIds: string[]
): ModelEntry[] {
  const existingIds = new Set(provider.models.map(m => m.modelId))
  const merged: ModelEntry[] = [...provider.models]
  for (const modelId of remoteModelIds) {
    const trimmed = modelId.trim()
    if (!trimmed || existingIds.has(trimmed)) continue
    existingIds.add(trimmed)
    merged.push({ id: generateLocalId('model'), modelId: trimmed })
  }
  return merged
}

/** 可供 UI 选择的模型项 */
export interface SelectableModel {
  providerId: string
  providerName: string
  modelEntryId: string
  modelId: string
  displayName: string
  isActive: boolean
}

/** 列出所有可选择的模型（provider 可用且模型未退役）。 */
export function listSelectableModels(registry: LlmRegistry): SelectableModel[] {
  const items: SelectableModel[] = []
  for (const provider of registry.providers) {
    if (!provider.enabled || !provider.baseUrl.trim() || !provider.apiKey.trim()) continue
    for (const entry of provider.models) {
      if (entry.retired === true || !entry.modelId.trim()) continue
      items.push({
        providerId: provider.id,
        providerName: provider.name,
        modelEntryId: entry.id,
        modelId: entry.modelId,
        displayName: entry.displayName ?? entry.modelId,
        isActive:
          registry.activeModel.providerId === provider.id &&
          registry.activeModel.modelEntryId === entry.id
      })
    }
  }
  return items
}

/** 按服务商分组的可选项（用于级联菜单） */
export interface SelectableProviderGroup {
  providerId: string
  providerName: string
  models: SelectableModel[]
}

export function groupSelectableModels(registry: LlmRegistry): SelectableProviderGroup[] {
  const map = new Map<string, SelectableProviderGroup>()
  for (const item of listSelectableModels(registry)) {
    let group = map.get(item.providerId)
    if (!group) {
      group = {
        providerId: item.providerId,
        providerName: item.providerName,
        models: []
      }
      map.set(item.providerId, group)
    }
    group.models.push(item)
  }
  return Array.from(map.values())
}

/** 获取模型展示名 */
export function getActiveModelDisplayName(registry: LlmRegistry): string | null {
  const provider = findProvider(registry, registry.activeModel.providerId)
  if (!provider) return null
  const entry = findModelEntry(provider, registry.activeModel.modelEntryId)
  if (!entry) return null
  return entry.displayName ?? entry.modelId
}

/** 获取活跃模型的默认思考强度；未配置时视为 auto */
export function getActiveModelReasoningEffort(registry: LlmRegistry): ReasoningEffort {
  const provider = findProvider(registry, registry.activeModel.providerId)
  if (!provider) return 'auto'
  const entry = findModelEntry(provider, registry.activeModel.modelEntryId)
  return entry?.reasoningEffort ?? 'auto'
}

/** 未登记能力时返回 null；auto 始终安全，因为它不会向 provider 发送 effort。 */
export function getSupportedReasoningEfforts(entry: ModelEntry): readonly ReasoningEffort[] | null {
  const efforts = lookupModelCapability(entry.modelId)?.reasoningEfforts
  return efforts ? ['auto', ...efforts] : null
}

/** 判断 effort 是否被指定模型支持（缺省视为 auto）。 */
export function isReasoningEffortSupported(entry: ModelEntry, effort?: ReasoningEffort): boolean {
  const normalized = effort ?? 'auto'
  if (normalized === 'auto') return true
  return getSupportedReasoningEfforts(entry)?.includes(normalized) === true
}

/**
 * 将 v1 单 ModelConfig 迁移为 v2 LlmRegistry
 */
export function migrateV1ToV2(v1: ModelConfig): LlmRegistry {
  const primaryProviderId = 'migrated-primary'
  const primaryModelEntryId = generateLocalId('model')

  const providers: ProviderConfig[] = [
    {
      id: primaryProviderId,
      name: '已迁移配置',
      baseUrl: v1.baseUrl,
      apiKey: v1.apiKey,
      enabled: true,
      models: [
        {
          id: primaryModelEntryId,
          modelId: v1.modelId,
          contextWindow: v1.contextWindow,
          supportsVision: v1.supportsVision
        }
      ],
      toolDialect: v1.toolDialect
    }
  ]

  const fallbacks: ActiveModelRef[] = []

  v1.fallbacks?.forEach((fb, index) => {
    if (!fb.baseUrl?.trim() || !fb.apiKey?.trim() || !fb.modelId?.trim()) return
    const pid = `migrated-fallback-${index}`
    const mid = generateLocalId('model')
    providers.push({
      id: pid,
      name: `备用 ${index + 1}`,
      baseUrl: fb.baseUrl,
      apiKey: fb.apiKey,
      enabled: true,
      models: [{ id: mid, modelId: fb.modelId }]
    })
    fallbacks.push({ providerId: pid, modelEntryId: mid })
  })

  return {
    version: 2,
    providers,
    activeModel: { providerId: primaryProviderId, modelEntryId: primaryModelEntryId },
    ...(fallbacks.length > 0 ? { fallbacks } : {})
  }
}

/** 创建空注册表（首次打开设置、尚未配置任何服务商） */
export function createEmptyRegistry(): LlmRegistry {
  return {
    version: 2,
    providers: [],
    activeModel: { providerId: '', modelEntryId: '' }
  }
}

/** 判断磁盘 JSON 是否为 v2 格式 */
export function isLlmRegistryV2(raw: unknown): raw is LlmRegistry {
  if (!raw || typeof raw !== 'object') return false
  const obj = raw as Record<string, unknown>
  return obj.version === 2 && Array.isArray(obj.providers) && typeof obj.activeModel === 'object'
}

/** 模型选择解析的有界候选上限 */
export const MAX_MODEL_SELECTOR_CANDIDATES = 5

/** 模型目录的默认条数与字符预算 */
export const MODEL_DIRECTORY_DEFAULT_LIMIT = 50
export const MODEL_DIRECTORY_MAX_CHARS = 20_000

export interface ModelSelectorCandidate {
  readonly selector: string
  readonly providerId: string
  readonly providerName: string
  readonly modelEntryId: string
  readonly modelId: string
  readonly displayName: string
  readonly aliases: readonly string[]
}

export type ModelSelectorStatus =
  | 'resolved'
  | 'not_found'
  | 'ambiguous'
  | 'unavailable'
  | 'unsupported_effort'

export type ModelSelectorResult =
  | {
      readonly status: 'resolved'
      readonly provider: ProviderConfig
      readonly entry: ModelEntry
      readonly ref: ActiveModelRef
      readonly supportedEfforts: readonly ReasoningEffort[] | null
    }
  | {
      readonly status: 'not_found'
      readonly candidates: readonly ModelSelectorCandidate[]
    }
  | {
      readonly status: 'ambiguous'
      readonly candidates: readonly ModelSelectorCandidate[]
    }
  | {
      readonly status: 'unavailable'
      readonly reason: Exclude<ModelResolutionStatus, 'available'>
      readonly provider?: ProviderConfig
      readonly entry?: ModelEntry
      readonly candidates?: readonly ModelSelectorCandidate[]
    }
  | {
      readonly status: 'unsupported_effort'
      readonly reason: 'unsupported_effort'
      readonly provider: ProviderConfig
      readonly entry: ModelEntry
      readonly requestedEffort: ReasoningEffort
      readonly supportedEfforts: readonly ReasoningEffort[] | null
    }

export interface ModelDirectoryEntry {
  readonly selector: string
  readonly providerId: string
  readonly providerName: string
  readonly modelEntryId: string
  readonly modelId: string
  readonly displayName: string
  readonly aliases: readonly string[]
  readonly availability: 'available' | 'unavailable'
  readonly reason?: Exclude<ModelResolutionStatus, 'available'>
  readonly supportedEfforts: readonly ReasoningEffort[] | null
  readonly isActive: boolean
}

export interface ModelDirectoryResult {
  readonly entries: readonly ModelDirectoryEntry[]
  readonly total: number
  readonly truncated: boolean
}

function normalizeSelectorValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\/:\s]+/g, ' ')
    .replace(/[._\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function toSelectorCandidate(provider: ProviderConfig, entry: ModelEntry): ModelSelectorCandidate {
  return {
    selector: `${provider.id}::${entry.id}`,
    providerId: provider.id,
    providerName: provider.name,
    modelEntryId: entry.id,
    modelId: entry.modelId,
    displayName: entry.displayName ?? entry.modelId,
    aliases: entry.aliases ? [...entry.aliases] : []
  }
}

function buildNormalizedKeys(provider: ProviderConfig, entry: ModelEntry): string[] {
  const keys: string[] = []
  const providerNorm = normalizeSelectorValue(provider.name)
  const idNorm = normalizeSelectorValue(provider.id)
  const modelIdNorm = normalizeSelectorValue(entry.modelId)
  const displayNorm = entry.displayName ? normalizeSelectorValue(entry.displayName) : ''
  const aliasNorms = (entry.aliases ?? []).map(normalizeSelectorValue).filter(Boolean)

  if (modelIdNorm) keys.push(modelIdNorm)
  if (displayNorm) keys.push(displayNorm)
  for (const alias of aliasNorms) keys.push(alias)
  if (providerNorm) {
    keys.push(providerNorm)
    if (idNorm && idNorm !== providerNorm) keys.push(idNorm)
    if (modelIdNorm) keys.push(`${providerNorm} ${modelIdNorm}`)
    if (idNorm && idNorm !== providerNorm && modelIdNorm) keys.push(`${idNorm} ${modelIdNorm}`)
    if (displayNorm) keys.push(`${providerNorm} ${displayNorm}`)
    if (idNorm && idNorm !== providerNorm && displayNorm) keys.push(`${idNorm} ${displayNorm}`)
    for (const alias of aliasNorms) {
      keys.push(`${providerNorm} ${alias}`)
      if (idNorm && idNorm !== providerNorm) keys.push(`${idNorm} ${alias}`)
    }
  }
  return Array.from(new Set(keys.filter(Boolean)))
}

function sortCandidates(candidates: ModelSelectorCandidate[]): ModelSelectorCandidate[] {
  return [...candidates].sort((a, b) => {
    const providerCompare = a.providerName.localeCompare(b.providerName)
    if (providerCompare !== 0) return providerCompare
    const displayCompare = a.displayName.localeCompare(b.displayName)
    if (displayCompare !== 0) return displayCompare
    const modelCompare = a.modelId.localeCompare(b.modelId)
    if (modelCompare !== 0) return modelCompare
    return a.selector.localeCompare(b.selector)
  })
}

function boundedCandidates(candidates: ModelSelectorCandidate[]): ModelSelectorCandidate[] {
  const sorted = sortCandidates(candidates)
  return sorted.slice(0, MAX_MODEL_SELECTOR_CANDIDATES)
}

/**
 * 纯解析器：自然语言/displayName/alias/canonical 到 providerId+modelEntryId 的解析与歧义判断。
 * - 优先接受 canonical providerId+modelEntryId；
 * - 自然语言匹配仅针对 provider 名、modelId、displayName 和显式 alias 的规范化精确匹配；
 * - 跨 provider 只有唯一结果时才解析；多结果返回有界候选，禁止编辑距离猜测与取第一个。
 */
export function resolveModelSelector(
  registry: LlmRegistry,
  rawSelector: string | ActiveModelRef,
  requestedEffort?: ReasoningEffort
): ModelSelectorResult {
  const effort = requestedEffort ?? 'auto'

  // Canonical object path
  if (typeof rawSelector !== 'string') {
    const ref: ActiveModelRef = { providerId: rawSelector.providerId, modelEntryId: rawSelector.modelEntryId }
    const resolved = resolveModelReference(registry, ref)
    if (resolved.status !== 'available') {
      return { status: 'unavailable', reason: resolved.status, provider: resolved.provider, entry: resolved.entry }
    }
    const supported = getSupportedReasoningEfforts(resolved.entry)
    if (effort !== 'auto' && supported?.includes(effort) !== true) {
      return {
        status: 'unsupported_effort',
        reason: 'unsupported_effort',
        provider: resolved.provider,
        entry: resolved.entry,
        requestedEffort: effort,
        supportedEfforts: supported
      }
    }
    return { status: 'resolved', provider: resolved.provider, entry: resolved.entry, ref, supportedEfforts: supported }
  }

  const selector = rawSelector.trim()
  if (!selector) return { status: 'not_found', candidates: [] }

  // Canonical string "providerId::modelEntryId"
  if (selector.includes('::')) {
    const [providerId, modelEntryId] = selector.split('::')
    if (providerId && modelEntryId) {
      const ref: ActiveModelRef = { providerId: providerId.trim(), modelEntryId: modelEntryId.trim() }
      const resolved = resolveModelReference(registry, ref)
      if (resolved.status !== 'available') {
        return { status: 'unavailable', reason: resolved.status, provider: resolved.provider, entry: resolved.entry }
      }
      const supported = getSupportedReasoningEfforts(resolved.entry)
      if (effort !== 'auto' && supported?.includes(effort) !== true) {
        return {
          status: 'unsupported_effort',
          reason: 'unsupported_effort',
          provider: resolved.provider,
          entry: resolved.entry,
          requestedEffort: effort,
          supportedEfforts: supported
        }
      }
      return { status: 'resolved', provider: resolved.provider, entry: resolved.entry, ref, supportedEfforts: supported }
    }
  }

  const normalized = normalizeSelectorValue(selector)
  if (!normalized) return { status: 'not_found', candidates: [] }

  const matches: Array<{ provider: ProviderConfig; entry: ModelEntry }> = []
  for (const provider of registry.providers) {
    for (const entry of provider.models) {
      if (!entry.modelId.trim()) continue
      const keys = buildNormalizedKeys(provider, entry)
      if (keys.includes(normalized)) {
        matches.push({ provider, entry })
      }
    }
  }

  if (matches.length === 0) {
    return { status: 'not_found', candidates: [] }
  }

  if (matches.length > 1) {
    const candidates = boundedCandidates(matches.map(({ provider, entry }) => toSelectorCandidate(provider, entry)))
    return { status: 'ambiguous', candidates }
  }

  const single = matches[0]!
  const ref: ActiveModelRef = { providerId: single.provider.id, modelEntryId: single.entry.id }
  const resolved = resolveModelReference(registry, ref)
  if (resolved.status !== 'available') {
    return { status: 'unavailable', reason: resolved.status, provider: resolved.provider, entry: resolved.entry, candidates: [toSelectorCandidate(single.provider, single.entry)] }
  }
  const supported = getSupportedReasoningEfforts(resolved.entry)
  if (effort !== 'auto' && supported?.includes(effort) !== true) {
    return {
      status: 'unsupported_effort',
      reason: 'unsupported_effort',
      provider: resolved.provider,
      entry: resolved.entry,
      requestedEffort: effort,
      supportedEfforts: supported
    }
  }
  return { status: 'resolved', provider: resolved.provider, entry: resolved.entry, ref, supportedEfforts: supported }
}

/** 校验 effort 是否受支持；不支持时返回可选集合供 fail-closed 诊断。 */
export function validateReasoningEffort(
  entry: ModelEntry,
  requestedEffort?: ReasoningEffort
): { ok: true; supportedEfforts: readonly ReasoningEffort[] | null } | {
  ok: false
  supportedEfforts: readonly ReasoningEffort[] | null
  requestedEffort: ReasoningEffort
} {
  const supported = getSupportedReasoningEfforts(entry)
  const normalized = requestedEffort ?? 'auto'
  if (normalized === 'auto' || supported?.includes(normalized) === true) {
    return { ok: true, supportedEfforts: supported }
  }
  return { ok: false, supportedEfforts: supported, requestedEffort: normalized }
}

/** 单一可信的模型选择只读投影：不暴露 baseUrl/凭据/完整 ModelConfig，带稳定排序与预算。 */
export function getModelDirectory(
  registry: LlmRegistry,
  options?: { limit?: number; maxChars?: number }
): ModelDirectoryResult {
  const limit = Math.min(options?.limit ?? MODEL_DIRECTORY_DEFAULT_LIMIT, MODEL_DIRECTORY_DEFAULT_LIMIT)
  const maxChars = options?.maxChars ?? MODEL_DIRECTORY_MAX_CHARS

  const entries: ModelDirectoryEntry[] = []
  for (const provider of registry.providers) {
    for (const entry of provider.models) {
      if (!entry.modelId.trim()) continue
      const ref: ActiveModelRef = { providerId: provider.id, modelEntryId: entry.id }
      const resolved = resolveModelReference(registry, ref)
      const availability: ModelDirectoryEntry['availability'] = resolved.status === 'available' ? 'available' : 'unavailable'
      const supportedEfforts = getSupportedReasoningEfforts(entry)
      const directoryEntry: ModelDirectoryEntry = {
        selector: `${provider.id}::${entry.id}`,
        providerId: provider.id,
        providerName: provider.name,
        modelEntryId: entry.id,
        modelId: entry.modelId,
        displayName: entry.displayName ?? entry.modelId,
        aliases: entry.aliases ? [...entry.aliases] : [],
        availability,
        ...(availability === 'unavailable' ? { reason: resolved.status as Exclude<ModelResolutionStatus, 'available'> } : {}),
        supportedEfforts,
        isActive: registry.activeModel.providerId === provider.id && registry.activeModel.modelEntryId === entry.id
      }
      entries.push(directoryEntry)
    }
  }

  entries.sort((a, b) => {
    const providerCompare = a.providerName.localeCompare(b.providerName)
    if (providerCompare !== 0) return providerCompare
    const displayCompare = a.displayName.localeCompare(b.displayName)
    if (displayCompare !== 0) return displayCompare
    const modelCompare = a.modelId.localeCompare(b.modelId)
    if (modelCompare !== 0) return modelCompare
    return a.selector.localeCompare(b.selector)
  })

  const total = entries.length
  let truncated = false
  let sliced = entries
  if (sliced.length > limit) {
    sliced = sliced.slice(0, limit)
    truncated = true
  }

  let charCount = 0
  const budgeted: ModelDirectoryEntry[] = []
  for (const entry of sliced) {
    const jsonLen = JSON.stringify(entry).length
    if (charCount + jsonLen > maxChars && budgeted.length > 0) {
      truncated = true
      break
    }
    charCount += jsonLen
    budgeted.push(entry)
  }

  return { entries: budgeted, total, truncated }
}

/** 校验并规范化 LlmRegistry */
export type LlmRegistryValidationResult =
  | { valid: true; registry: LlmRegistry }
  | { valid: false; message: string }

export function validateLlmRegistry(raw: unknown): LlmRegistryValidationResult {
  if (!isLlmRegistryV2(raw)) {
    return { valid: false, message: '配置格式无效：需要 version 2 注册表' }
  }

  if (raw.providers.length === 0) {
    return { valid: false, message: '至少需要一个服务商' }
  }

  const providers: ProviderConfig[] = []
  for (const p of raw.providers) {
    if (!p.id || !p.name) {
      return { valid: false, message: '服务商缺少 id 或 name' }
    }
    const baseUrl = (p.baseUrl ?? '').trim()
    if (!baseUrl || !/^https?:\/\/.+/.test(baseUrl)) {
      return { valid: false, message: `服务商「${p.name}」的接口地址无效` }
    }
    if (!Array.isArray(p.models)) {
      return { valid: false, message: `服务商「${p.name}」的模型列表无效` }
    }
    for (const model of p.models) {
      if (model.retired !== undefined && typeof model.retired !== 'boolean') {
        return { valid: false, message: `服务商「${p.name}」的模型退役状态无效` }
      }
      if (model.aliases !== undefined) {
        if (!Array.isArray(model.aliases) || model.aliases.some(item => typeof item !== 'string' || !item.trim() || item.length > 128)) {
          return { valid: false, message: `服务商「${p.name}」的模型别名无效` }
        }
      }
    }
    providers.push({
      id: p.id,
      name: p.name.trim(),
      ...(p.presetId ? { presetId: p.presetId } : {}),
      baseUrl,
      apiKey: (p.apiKey ?? '').trim(),
      ...(typeof p.connectionRevision === 'string' && /^[a-f0-9-]{36}$/.test(p.connectionRevision) ? { connectionRevision: p.connectionRevision } : {}),
      enabled: p.enabled !== false,
      models: (p.models ?? []).map(m => ({
        id: m.id || generateLocalId('model'),
        modelId: (m.modelId ?? '').trim(),
        ...(m.displayName ? { displayName: m.displayName.trim() } : {}),
        ...(Array.isArray(m.aliases)
          ? {
              aliases: (m.aliases as unknown[])
                .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
                .map(item => item.trim())
                .slice(0, 8)
            }
          : {}),
        ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
        ...(m.supportsVision !== undefined ? { supportsVision: m.supportsVision } : {}),
        ...(m.reasoningEffort && m.reasoningEffort !== 'auto'
          ? { reasoningEffort: m.reasoningEffort }
          : {}),
        ...(m.retired === true ? { retired: true } : {})
      })),
      ...(p.toolDialect && p.toolDialect !== 'auto' ? { toolDialect: p.toolDialect } : {})
    })
  }

  const activeProvider = providers.find(p => p.id === raw.activeModel.providerId)
  if (!activeProvider) {
    return { valid: false, message: '活跃模型引用的服务商不存在' }
  }
  const activeEntry = activeProvider.models.find(m => m.id === raw.activeModel.modelEntryId)
  if (!activeEntry) {
    return { valid: false, message: '活跃模型引用的模型不存在' }
  }

  const fallbacks: ActiveModelRef[] = []
  for (const ref of raw.fallbacks ?? []) {
    const fp = providers.find(p => p.id === ref.providerId)
    const fe = fp?.models.find(m => m.id === ref.modelEntryId)
    if (fp && fe) {
      fallbacks.push({ providerId: ref.providerId, modelEntryId: ref.modelEntryId })
    }
  }

  return {
    valid: true,
    registry: {
      version: 2,
      providers,
      activeModel: {
        providerId: raw.activeModel.providerId,
        modelEntryId: raw.activeModel.modelEntryId
      },
      ...(fallbacks.length > 0 ? { fallbacks } : {})
    }
  }
}
