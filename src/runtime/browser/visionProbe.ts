import type { ModelClient } from '../model/ModelClient'

export const BROWSER_VISION_PROBE_MARKER = 'NOVA_BROWSER_VISION_PROBE'

const PROBE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const probeByProvider = new Map<string, boolean>()
const probeByClient = new WeakMap<ModelClient, boolean>()
const testCache = new Map<string, boolean>()

export function resetVisionProbeCacheForTests(): void {
  probeByProvider.clear()
  testCache.clear()
}

/**
 * 对当前活跃 provider 做一次真实发图探测。关键字/注册表不得单独作为可用依据。
 * 探测失败（含 4xx/5xx）视为不可用，调用方应降级为文字结果。
 */
export async function probeProviderVision(
  modelClient: ModelClient | undefined,
  options: { readonly cacheKey?: string; readonly abortSignal?: AbortSignal } = {}
): Promise<boolean> {
  if (!modelClient) return false
  const providerKey = options.cacheKey ?? activeProviderKey(modelClient)
  if (providerKey) {
    const cached = testCache.get(providerKey) ?? probeByProvider.get(providerKey)
    if (cached !== undefined) return cached
  } else {
    const cached = probeByClient.get(modelClient)
    if (cached !== undefined) return cached
  }

  const available = await runProbe(modelClient, options.abortSignal)
  if (providerKey) {
    if (options.cacheKey) testCache.set(providerKey, available)
    else probeByProvider.set(providerKey, available)
  } else {
    probeByClient.set(modelClient, available)
  }
  return available
}

function activeProviderKey(client: ModelClient): string | null {
  if (!('getActiveProvider' in client) || typeof client.getActiveProvider !== 'function') {
    return null
  }
  const info: unknown = client.getActiveProvider()
  if (!info || typeof info !== 'object') return null
  const record = info as { baseUrl?: unknown; modelId?: unknown }
  if (typeof record.baseUrl !== 'string' || typeof record.modelId !== 'string') return null
  const baseUrl = record.baseUrl.trim()
  const modelId = record.modelId.trim()
  if (!baseUrl || !modelId) return null
  return `${baseUrl}::${modelId}`
}

async function runProbe(modelClient: ModelClient, abortSignal?: AbortSignal): Promise<boolean> {
  try {
    const stream = modelClient.chat(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: BROWSER_VISION_PROBE_MARKER },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${PROBE_PNG}` }
            }
          ]
        }
      ],
      [],
      {
        abortSignal,
        transportTimeouts: {
          connectMs: 8_000,
          firstByteMs: 8_000,
          idleMs: 8_000,
          totalMs: 12_000
        }
      }
    )
    for await (const event of stream) {
      if (event.type === 'error' || event.type === 'context_overflow' || event.type === 'cancelled') {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}
