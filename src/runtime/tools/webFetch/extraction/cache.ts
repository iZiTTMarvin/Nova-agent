import type { PageExtraction } from './types'

/** 有界 LRU + 可选 single-flight；无稳定运行身份时不共享绑定取消信号的在途请求。 */
export class ExtractionResultCache {
  private readonly entries = new Map<string, PageExtraction>()
  private readonly pending = new Map<string, Promise<PageExtraction>>()
  private readonly generations = new Map<string, number>()
  private nextGeneration = 0

  constructor(
    private readonly maxEntries = 64,
    private readonly maxGenerations = 256
  ) {}

  getOrLoad(
    cacheKey: string,
    pendingKey: string | undefined,
    force: boolean,
    load: () => Promise<PageExtraction>
  ): Promise<PageExtraction> {
    if (!force) {
      const cached = this.entries.get(cacheKey)
      if (cached) {
        this.entries.delete(cacheKey)
        this.entries.set(cacheKey, cached)
        return Promise.resolve(cached)
      }
    }

    if (pendingKey) {
      const existing = this.pending.get(pendingKey)
      if (existing) return existing
    }
    const generation = this.trackGeneration(cacheKey)
    const promise = Promise.resolve().then(load).then(result => {
      // 后发起的 force 可能先完成；旧请求不得回写覆盖较新的结果。
      if (!('error' in result) && this.generations.get(cacheKey) === generation) {
        this.entries.delete(cacheKey)
        this.entries.set(cacheKey, result)
        while (this.entries.size > this.maxEntries) {
          const oldest = this.entries.keys().next().value
          if (oldest === undefined) break
          this.entries.delete(oldest)
        }
      }
      return result
    }).finally(() => {
      if (pendingKey && this.pending.get(pendingKey) === promise) this.pending.delete(pendingKey)
    })
    if (pendingKey) this.pending.set(pendingKey, promise)
    return promise
  }

  private trackGeneration(cacheKey: string): number {
    const generation = ++this.nextGeneration
    this.generations.delete(cacheKey)
    this.generations.set(cacheKey, generation)
    while (this.generations.size > this.maxGenerations) {
      const oldest = this.generations.keys().next().value
      if (oldest === undefined) break
      this.generations.delete(oldest)
    }
    return generation
  }
}
