import { describe, expect, it } from 'vitest'
import {
  resolveChildModelFromHeader,
  resolveChildModelFromProfile
} from '../../../src/main/agent/subagents/childModelRouting'
import type { LlmRegistry, ProviderConfig } from '../../../src/shared/config'
import type { SubagentProfileSnapshot } from '../../../src/shared/subagents'

const profile: SubagentProfileSnapshot = {
  profileId: 'code',
  name: 'code',
  description: 'code child',
  systemPrompt: 'work',
  toolNames: ['read'],
  permissionCeiling: 'read_only',
  maxToolRounds: 20,
  configHash: 'hash',
  model: {
    providerId: 'provider-a',
    modelEntryId: 'model-a',
    reasoningEffort: 'high'
  }
}

function createProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-a',
    name: 'Provider A',
    baseUrl: 'https://provider-a.example/v1',
    apiKey: 'routing-test-key',
    enabled: true,
    toolDialect: 'native',
    models: [{
      id: 'model-a',
      modelId: 'api-model-a',
      contextWindow: 64_000,
      supportsVision: true,
      reasoningEffort: 'medium'
    }],
    ...overrides
  }
}

function registry(): LlmRegistry {
  return {
    version: 2,
    providers: [
      createProvider(),
      {
        id: 'provider-b',
        name: 'Provider B',
        baseUrl: 'https://provider-b.example/v1',
        apiKey: 'routing-test-key-b',
        enabled: true,
        models: [{
          id: 'model-b',
          modelId: 'api-model-b',
          contextWindow: 32_000,
          supportsVision: false,
          reasoningEffort: 'low'
        }]
      }
    ],
    activeModel: { providerId: 'provider-b', modelEntryId: 'model-b' }
  }
}

describe('child model routing', () => {
  it('profile binding wins over active model and uses entry capabilities', () => {
    const resolved = resolveChildModelFromProfile(registry(), profile)

    expect(resolved.header).toEqual({
      providerId: 'provider-a',
      modelEntryId: 'model-a',
      modelId: 'api-model-a',
      reasoningEffort: 'high'
    })
    expect(resolved.modelConfig).toMatchObject({
      modelId: 'api-model-a',
      apiKey: 'routing-test-key',
      contextWindow: 64_000,
      supportsVision: true,
      reasoningEffort: 'high',
      cacheProfile: 'generic',
      toolDialect: 'native'
    })
  })

  it('unbound profile resolves the registry active model and its default effort', () => {
    const resolved = resolveChildModelFromProfile(registry(), {
      ...profile,
      model: undefined
    })

    expect(resolved.header).toEqual({
      providerId: 'provider-b',
      modelEntryId: 'model-b',
      modelId: 'api-model-b',
      reasoningEffort: 'low'
    })
  })

  it('header effort stays frozen when the registry default changes', () => {
    const header = resolveChildModelFromProfile(registry(), profile).header
    const changed = registry()
    changed.providers[0]!.models[0]!.reasoningEffort = 'low'

    const restored = resolveChildModelFromHeader(changed, header)

    expect(restored.header.reasoningEffort).toBe('high')
    expect(restored.modelConfig.reasoningEffort).toBe('high')
  })

  it('rejects a public modelId drift during header recovery', () => {
    const header = resolveChildModelFromProfile(registry(), profile).header
    const changed = registry()
    changed.providers[0]!.models[0]!.modelId = 'changed-model'

    expect(() => resolveChildModelFromHeader(changed, header)).toThrow()
  })

  it.each([
    {
      name: 'disabled provider',
      mutate: (value: LlmRegistry) => { value.providers[0]!.enabled = false }
    },
    {
      name: 'missing provider',
      mutate: (value: LlmRegistry) => { value.providers = value.providers.slice(1) }
    },
    {
      name: 'missing credentials',
      mutate: (value: LlmRegistry) => { value.providers[0]!.apiKey = '' }
    },
    {
      name: 'missing model entry',
      mutate: (value: LlmRegistry) => { value.providers[0]!.models = [] }
    },
    {
      name: 'retired model entry',
      mutate: (value: LlmRegistry) => { value.providers[0]!.models[0]!.retired = true }
    }
  ])('$name is rejected without active-model fallback', ({ mutate }) => {
    const header = resolveChildModelFromProfile(registry(), profile).header
    const unavailable = registry()
    mutate(unavailable)

    expect(() => resolveChildModelFromHeader(unavailable, header)).toThrow()
  })

  it('rejects legacy profile model references before child creation', () => {
    expect(() => resolveChildModelFromProfile(registry(), {
      ...profile,
      model: { providerId: 'provider-a', modelId: 'api-model-a' }
    })).toThrow()
  })
})
