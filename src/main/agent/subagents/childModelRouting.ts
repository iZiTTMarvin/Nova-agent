import {
  getSupportedReasoningEfforts,
  resolveContextWindow,
  resolveModelReference,
  resolveSupportsVision,
  type ActiveModelRef,
  type LlmRegistry,
  type ModelResolutionResult
} from '../../../shared/config'
import type { ModelConfig } from '../../../shared/config'
import type {
  SubagentModelBinding,
  SubagentProfileSnapshot,
  SubagentSessionHeader
} from '../../../shared/subagents'
import { resolveCacheProfile } from '../../../runtime/model/cacheProfile'

export interface ResolvedChildModel {
  readonly header: SubagentSessionHeader
  readonly modelConfig: ModelConfig
  readonly contextWindow: number
  readonly supportsVision: boolean
}

export interface ResolveChildModelOptions {
  readonly modelOverride?: ActiveModelRef
  readonly reasoningEffortOverride?: SubagentSessionHeader['reasoningEffort']
}

/** 首次派生按 单次覆盖 > preset 固定绑定 > 派遣时 activeModel 解析，并只冻结最小 header。 */
export function resolveChildModelFromProfile(
  registry: LlmRegistry,
  profile: SubagentProfileSnapshot,
  options: ResolveChildModelOptions = {}
): ResolvedChildModel {
  const model = profile.model
  if (model && !isSubagentModelBinding(model)) {
    throw new Error(
      `子代理 profile ${profile.profileId} 使用旧 modelId 引用，无法执行；请重新绑定 providerId + modelEntryId`
    )
  }
  const overrideRef = options.modelOverride
  const ref: ActiveModelRef = overrideRef
    ? { providerId: overrideRef.providerId, modelEntryId: overrideRef.modelEntryId }
    : model
      ? { providerId: model.providerId, modelEntryId: model.modelEntryId }
      : registry.activeModel
  const resolved = resolveAvailableModel(registry, ref)
  const reasoningEffort: SubagentSessionHeader['reasoningEffort'] =
    options.reasoningEffortOverride ?? model?.reasoningEffort ?? resolved.entry.reasoningEffort ?? 'auto'
  if (reasoningEffort !== 'auto') {
    const supported = getSupportedReasoningEfforts(resolved.entry)
    if (!supported) {
      throw new Error(
        `子代理模型 ${ref.providerId}/${ref.modelEntryId} 的思考强度能力未知，仅可使用 auto`
      )
    }
    if (!supported.includes(reasoningEffort)) {
      throw new Error(
        `子代理模型 ${ref.providerId}/${ref.modelEntryId} 不支持思考强度 ${reasoningEffort}，可选：${supported.join(', ')}`
      )
    }
  }
  return buildResolvedChildModel(resolved, {
    providerId: ref.providerId,
    modelEntryId: ref.modelEntryId,
    reasoningEffort
  })
}

/** 恢复时只接受持久 header，并拒绝 registry entry 的公开 modelId 漂移。 */
export function resolveChildModelFromHeader(
  registry: LlmRegistry,
  header: SubagentSessionHeader
): ResolvedChildModel {
  const resolved = resolveAvailableModel(registry, {
    providerId: header.providerId,
    modelEntryId: header.modelEntryId
  })
  const currentModelId = resolved.entry.modelId.trim()
  if (currentModelId !== header.modelId) {
    throw new Error(
      `子代理模型 ${header.providerId}/${header.modelEntryId} 的 modelId 已变化，无法恢复；请重新派遣`
    )
  }
  return buildResolvedChildModel(resolved, header)
}

function buildResolvedChildModel(
  resolved: Extract<ModelResolutionResult, { status: 'available' }>,
  identity: Pick<SubagentSessionHeader, 'providerId' | 'modelEntryId' | 'reasoningEffort'>
): ResolvedChildModel {
  const modelId = resolved.entry.modelId.trim()
  const cacheProfile = resolveCacheProfile(resolved.config.baseUrl, modelId)
  const contextWindow = resolveContextWindow(modelId, resolved.entry.contextWindow)
  const supportsVision = resolveSupportsVision(modelId, resolved.entry.supportsVision)
  const modelConfig: ModelConfig = {
    ...resolved.config,
    modelId,
    contextWindow,
    supportsVision,
    cacheProfile: cacheProfile.id,
    toolDialect: resolved.provider.toolDialect ?? 'auto',
    ...(identity.reasoningEffort !== 'auto' ? { reasoningEffort: identity.reasoningEffort } : {})
  }
  return {
    header: {
      providerId: identity.providerId,
      modelEntryId: identity.modelEntryId,
      modelId,
      reasoningEffort: identity.reasoningEffort
    },
    modelConfig,
    contextWindow,
    supportsVision
  }
}

function resolveAvailableModel(
  registry: LlmRegistry,
  ref: ActiveModelRef
): Extract<ModelResolutionResult, { status: 'available' }> {
  const resolved = resolveModelReference(registry, ref)
  if (resolved.status !== 'available') {
    throw new Error(formatModelResolutionFailure(ref, resolved))
  }
  return resolved
}

function isSubagentModelBinding(
  model: SubagentProfileSnapshot['model']
): model is SubagentModelBinding {
  return model !== undefined && 'modelEntryId' in model
}

function formatModelResolutionFailure(
  ref: ActiveModelRef,
  result: Exclude<ModelResolutionResult, { status: 'available' }>
): string {
  const identity = `${ref.providerId}/${ref.modelEntryId}`
  switch (result.status) {
    case 'provider_missing':
      return `子代理模型 ${identity} 不可用：provider 不存在`
    case 'provider_disabled':
      return `子代理模型 ${identity} 不可用：provider 已禁用`
    case 'credentials_missing':
      return `子代理模型 ${identity} 不可用：provider 缺少接口地址或凭据`
    case 'model_missing':
      return `子代理模型 ${identity} 不可用：model entry 不存在`
    case 'model_retired':
      return `子代理模型 ${identity} 不可用：model entry 已退役`
    case 'model_invalid':
      return `子代理模型 ${identity} 不可用：model ID 无效`
  }
}
