import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmRegistry, ModelConfig } from '../../../src/shared/config'

const loadRegistry = vi.fn<() => LlmRegistry | null>()
const usedConfigs: ModelConfig[] = []

vi.mock('electron', () => ({ app: { getPath: () => 'profile' } }))
vi.mock('../../../src/runtime/model/config', () => ({ loadLlmRegistry: () => loadRegistry() }))
vi.mock('../../../src/main/services/createModelClient', () => ({
  createModelClient: (config: ModelConfig) => {
    usedConfigs.push(config)
    return {
      async *chat() {
        yield { type: 'text_delta', delta: '{"candidates":[]}' }
        yield { type: 'done' }
      }
    }
  }
}))

const registry: LlmRegistry = {
  version: 2,
  providers: [
    { id: 'p-main', name: 'main', baseUrl: 'https://main.example/v1', apiKey: 'k1', enabled: true, models: [{ id: 'm-main', modelId: 'gpt-5.2' }] },
    { id: 'p-cheap', name: 'cheap', baseUrl: 'https://cheap.example/v1', apiKey: 'k2', enabled: true, models: [{ id: 'm-cheap', modelId: 'minimax-m2.5' }] }
  ],
  activeModel: { providerId: 'p-main', modelEntryId: 'm-main' }
}

beforeEach(() => {
  usedConfigs.length = 0
  loadRegistry.mockReset()
})

describe('createExtractChatFn', () => {
  it('后台记忆请求使用注册表中的后台模型与其最低思考档', async () => {
    loadRegistry.mockReturnValue({ ...registry, backgroundModel: { providerId: 'p-cheap', modelEntryId: 'm-cheap' } })
    const { createExtractChatFn } = await import('../../../src/main/services/MemoryModelChat')
    const text = await createExtractChatFn()([{ role: 'user', content: 'hi' }])
    expect(text).toBe('{"candidates":[]}')
    expect(usedConfigs.map(c => [c.modelId, c.reasoningEffort])).toEqual([['minimax-m2.5', 'high']])
  })

  it('未设置后台模型时跟随当前模型并降到最低思考档', async () => {
    loadRegistry.mockReturnValue(registry)
    const { createExtractChatFn } = await import('../../../src/main/services/MemoryModelChat')
    await createExtractChatFn()([{ role: 'user', content: 'hi' }])
    expect(usedConfigs.map(c => [c.modelId, c.reasoningEffort])).toEqual([['gpt-5.2', 'low']])
  })

  it('没有可用模型时拒绝请求，不静默返回空结果', async () => {
    loadRegistry.mockReturnValue(null)
    const { createExtractChatFn } = await import('../../../src/main/services/MemoryModelChat')
    await expect(createExtractChatFn()([{ role: 'user', content: 'hi' }])).rejects.toThrow()
  })
})
