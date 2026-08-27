import { describe, expect, it } from 'vitest'
import { buildSubagentCatalog } from '../../../../src/runtime/subagents'
import type { LlmRegistry } from '../../../../src/shared/config'
import type { SubAgentSpec } from '../../../../src/shared/settings/types'

const specs: SubAgentSpec[] = [
  {
    name: 'bound',
    description: 'bound child',
    allowedTools: ['read'],
    prompt: 'read',
    model: {
      providerId: 'provider-a',
      modelEntryId: 'model-a',
      reasoningEffort: 'high'
    }
  },
  {
    name: 'unbound',
    description: 'default child',
    allowedTools: ['read'],
    prompt: 'read'
  },
  {
    name: 'legacy',
    description: 'old child',
    allowedTools: ['read'],
    prompt: 'read',
    model: { providerId: 'provider-a', modelId: 'api-model-a' } as unknown as SubAgentSpec['model']
  },
  {
    name: 'malformed',
    description: 'invalid child',
    allowedTools: ['read'],
    prompt: 'read',
    model: {
      providerId: 'provider-a',
      modelEntryId: 'model-a',
      modelId: 'api-model-a'
    } as unknown as SubAgentSpec['model']
  }
]

function registry(overrides: Partial<LlmRegistry['providers'][number]> = {}): LlmRegistry {
  return {
    version: 2,
    providers: [
      {
        id: 'provider-a',
        name: 'Provider A',
        baseUrl: 'https://provider-a.example/v1',
        apiKey: 'secret-isolated-test-value',
        enabled: true,
        models: [
          {
            id: 'model-a',
            modelId: 'api-model-a',
            contextWindow: 32_000,
            supportsVision: true,
            reasoningEffort: 'medium'
          }
        ],
        ...overrides
      }
    ],
    activeModel: { providerId: 'provider-a', modelEntryId: 'model-a' }
  }
}

describe('buildSubagentCatalog', () => {
  it('exposes explicit and unbound effective model without credentials', () => {
    const entries = buildSubagentCatalog(specs, registry())
    expect(entries[0]).toMatchObject({
      profileId: 'bound',
      status: 'available',
      model: {
        providerId: 'provider-a',
        modelEntryId: 'model-a',
        modelId: 'api-model-a',
        reasoningEffort: 'high'
      }
    })
    expect(entries[1]).toMatchObject({
      profileId: 'unbound',
      status: 'available',
      model: { reasoningEffort: 'medium' }
    })
    expect(JSON.stringify(entries)).not.toContain('secret-isolated-test-value')
  })

  it('keeps unavailable reasons distinct', () => {
    expect(buildSubagentCatalog(specs.slice(0, 1), null)[0]).toMatchObject({
      status: 'unavailable',
      reason: 'provider_missing'
    })
    expect(buildSubagentCatalog(specs.slice(0, 1), registry({ enabled: false }))[0]).toMatchObject({
      status: 'unavailable',
      reason: 'provider_disabled'
    })

    const retired = registry()
    retired.providers[0]!.models[0]!.retired = true
    expect(buildSubagentCatalog(specs.slice(0, 1), retired)[0]).toMatchObject({
      status: 'unavailable',
      reason: 'model_retired'
    })
  })

  it('shows legacy and malformed bindings as unavailable instead of inheriting active model', () => {
    const entries = buildSubagentCatalog(specs.slice(2), registry())
    expect(entries[0]).toMatchObject({
      profileId: 'legacy',
      status: 'unavailable',
      reason: 'legacy_model_binding',
      model: { providerId: 'provider-a', modelId: 'api-model-a' }
    })
    expect(entries[1]).toMatchObject({
      profileId: 'malformed',
      status: 'unavailable',
      reason: 'invalid_model_binding'
    })
  })
})
