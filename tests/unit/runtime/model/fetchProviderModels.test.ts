import { describe, expect, it } from 'vitest'
import { resolveFetchApiKey } from '../../../../src/runtime/model/fetchProviderModels'
import type { LlmRegistry } from '../../../../src/shared/config/llmRegistry'

const onDisk: LlmRegistry = {
  version: 2,
  providers: [
    {
      id: 'custom-1',
      name: 'cmd',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-real-secret',
      enabled: true,
      models: []
    }
  ],
  activeModel: { providerId: '', modelEntryId: '' }
}

describe('resolveFetchApiKey', () => {
  it('掩码 key 且地址与已保存地址一致时还原为磁盘明文', () => {
    const key = resolveFetchApiKey(
      { baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-***ret', providerId: 'custom-1' },
      onDisk
    )
    expect(key).toBe('sk-real-secret')
  })

  it('地址被改动时不得把磁盘明文发往新地址', () => {
    const key = resolveFetchApiKey(
      { baseUrl: 'https://attacker.example/v1', apiKey: 'sk-***ret', providerId: 'custom-1' },
      onDisk
    )
    expect(key).toBe('sk-***ret')
  })

  it('用户重新输入的明文 key 原样使用', () => {
    const key = resolveFetchApiKey(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-new', providerId: 'custom-1' },
      onDisk
    )
    expect(key).toBe('sk-new')
  })
})
