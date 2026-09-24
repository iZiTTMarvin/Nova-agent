import { afterEach, describe, expect, it } from 'vitest'
import { ModelClientPool } from '../../../../src/runtime/model/ModelClientPool'
import type { ModelClient } from '../../../../src/runtime/model/ModelClient'
import type { ChatEvent } from '../../../../src/runtime/model/types'
import {
  probeProviderVision,
  resetVisionProbeCacheForTests
} from '../../../../src/runtime/browser/visionProbe'

afterEach(() => {
  resetVisionProbeCacheForTests()
})

function client(result: 'ok' | 'error', hits: { count: number }): ModelClient {
  return {
    async *chat(): AsyncIterable<ChatEvent> {
      hits.count += 1
      if (result === 'error') {
        yield { type: 'error', error: '500' }
        return
      }
      yield { type: 'text_delta', delta: 'ok' }
    },
    updateConfig() {}
  }
}

describe('probeProviderVision', () => {
  it('按当前活跃 provider 缓存，fallback 后重新探测', async () => {
    const primaryHits = { count: 0 }
    const fallbackHits = { count: 0 }
    const pool = new ModelClientPool({
      primary: client('error', primaryHits),
      primaryConfig: {
        baseUrl: 'https://vision-a.example/v1',
        apiKey: 'k',
        modelId: 'model-a'
      },
      fallbacks: [
        {
          config: {
            baseUrl: 'https://vision-b.example/v1',
            apiKey: 'k',
            modelId: 'model-b'
          },
          client: client('ok', fallbackHits)
        }
      ]
    })

    expect(await probeProviderVision(pool)).toBe(false)
    expect(await probeProviderVision(pool)).toBe(false)
    expect(primaryHits.count).toBe(1)

    pool.switchToFallback(1)
    expect(await probeProviderVision(pool)).toBe(true)
    expect(await probeProviderVision(pool)).toBe(true)
    expect(fallbackHits.count).toBe(1)
    expect(primaryHits.count).toBe(1)
  })
})
