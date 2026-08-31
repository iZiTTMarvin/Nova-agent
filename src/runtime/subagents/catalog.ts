import {
  resolveModelReference,
  type ActiveModelRef,
  type LlmRegistry,
  type ModelResolutionStatus
} from '../../shared/config'
import type { SubAgentSpec } from '../../shared/settings/types'
import type {
  SubagentCatalogEntry,
  SubagentCatalogModel,
  SubagentModelBinding,
  SubagentProfileModel
} from '../../shared/subagents'

/**
 * 将已解码的 preset 列表与当前注册表 join 成不含凭据的只读 catalog。
 * profileId 是稳定派遣身份；name 仅作展示，重命名不影响可派遣性。
 */
export function buildSubagentCatalog(
  specs: readonly SubAgentSpec[],
  registry: LlmRegistry | null
): SubagentCatalogEntry[] {
  return specs.map((spec) => buildCatalogEntry(spec, registry))
}

function buildCatalogEntry(
  spec: SubAgentSpec,
  registry: LlmRegistry | null
): SubagentCatalogEntry {
  const model: SubagentProfileModel | undefined = spec.model
  if (model && !('modelEntryId' in model)) {
    return {
      profileId: spec.id,
      name: spec.name,
      description: spec.description,
      status: 'unavailable',
      reason: 'legacy_model_binding',
      model: { providerId: model.providerId, modelId: model.modelId }
    }
  }

  const ref: ActiveModelRef | undefined = model
    ? { providerId: model.providerId, modelEntryId: model.modelEntryId }
    : registry?.activeModel
  if (!registry || !ref) {
    return unavailable(spec, 'provider_missing', model)
  }

  const resolved = resolveModelReference(registry, ref)
  if (resolved.status !== 'available') {
    return unavailable(spec, resolved.status, model)
  }

  const reasoningEffort =
    model?.reasoningEffort ?? resolved.entry.reasoningEffort ?? 'auto'
  return {
    profileId: spec.id,
    name: spec.name,
    description: spec.description,
    status: 'available',
    model: {
      providerId: ref.providerId,
      modelEntryId: ref.modelEntryId,
      modelId: resolved.config.modelId,
      reasoningEffort
    }
  }
}

function unavailable(
  spec: SubAgentSpec,
  reason: Exclude<ModelResolutionStatus, 'available'>,
  model: SubagentModelBinding | undefined
): SubagentCatalogEntry {
  const safeModel: SubagentCatalogModel | undefined = model
    ? {
        providerId: model.providerId,
        modelEntryId: model.modelEntryId,
        ...(model.reasoningEffort !== undefined
          ? { reasoningEffort: model.reasoningEffort }
          : {})
      }
    : undefined
  return {
    profileId: spec.id,
    name: spec.name,
    description: spec.description,
    status: 'unavailable',
    reason,
    ...(safeModel ? { model: safeModel } : {})
  }
}
