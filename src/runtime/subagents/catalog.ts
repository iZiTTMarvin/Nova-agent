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
import { parseSubagentModel } from './profileResolver'

/** 将预设列表与当前注册表 join 成不含凭据的只读 catalog。 */
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
  let model: SubagentProfileModel | undefined
  try {
    model = spec.model === undefined ? undefined : parseSubagentModel(spec.model)
  } catch {
    return {
      profileId: spec.name,
      name: spec.name,
      description: spec.description,
      status: 'unavailable',
      reason: 'invalid_model_binding'
    }
  }
  if (model && !('modelEntryId' in model)) {
    return {
      profileId: spec.name,
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
    profileId: spec.name,
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
    profileId: spec.name,
    name: spec.name,
    description: spec.description,
    status: 'unavailable',
    reason,
    ...(safeModel ? { model: safeModel } : {})
  }
}
