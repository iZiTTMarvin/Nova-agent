import type { ModelClient } from '../model/ModelClient'

export const BROWSER_VISION_PROBE_MARKER = 'NOVA_BROWSER_VISION_PROBE'

const PROBE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const probeCache = new WeakMap<ModelClient, boolean>()
const testCache = new Map<string, boolean>()

export function resetVisionProbeCacheForTests(): void {
  testCache.clear()
}

/**
 * 对当前 client 做一次真实发图探测。关键字/注册表不得单独作为可用依据。
 * 探测失败（含 4xx/5xx）视为不可用，调用方应降级为文字结果。
 */
export async function probeProviderVision(
  modelClient: ModelClient | undefined,
  options: { readonly cacheKey?: string; readonly abortSignal?: AbortSignal } = {}
): Promise<boolean> {
  if (!modelClient) return false
  if (options.cacheKey) {
    const cached = testCache.get(options.cacheKey)
    if (cached !== undefined) return cached
  } else {
    const cached = probeCache.get(modelClient)
    if (cached !== undefined) return cached
  }

  const available = await runProbe(modelClient, options.abortSignal)
  if (options.cacheKey) testCache.set(options.cacheKey, available)
  else probeCache.set(modelClient, available)
  return available
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

