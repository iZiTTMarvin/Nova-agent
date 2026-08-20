import { availableParallelism } from 'node:os'

export const CODE_INDEX_PARSE_CONCURRENCY_MAX = 4

export class CodeIndexBuildCancelledError extends Error {
  readonly code = 'build_cancelled'

  constructor() {
    super('代码索引构建已取消')
    this.name = 'CodeIndexBuildCancelledError'
  }
}

export interface CodeIndexWorkSchedulerOptions {
  readonly cpuCount?: number
}

export interface CodeIndexWorkCancellation {
  readonly abortSignal?: AbortSignal
  readonly isAborted?: () => boolean
}

/** 所有语言的文件读取与解析共用同一预算；多核时留一核给主进程，单核时以并发 1 保证可用。 */
export class CodeIndexWorkScheduler {
  readonly concurrency: number

  constructor(options: CodeIndexWorkSchedulerOptions = {}) {
    const cpuCount = options.cpuCount ?? availableParallelism()
    if (!Number.isInteger(cpuCount) || cpuCount < 1) {
      throw new Error('Code Index CPU 数必须是正整数')
    }
    this.concurrency = Math.min(
      CODE_INDEX_PARSE_CONCURRENCY_MAX,
      Math.max(1, cpuCount - 1)
    )
  }

  async map<T, R>(
    items: readonly T[],
    work: (item: T, index: number) => Promise<R>,
    cancellation: CodeIndexWorkCancellation = {}
  ): Promise<readonly R[]> {
    throwIfCancelled(cancellation)
    let nextIndex = 0
    let stopped = false
    const results = new Map<number, { readonly value: R }>()
    const workers = Array.from(
      { length: Math.min(this.concurrency, items.length) },
      async () => {
        while (!stopped) {
          throwIfCancelled(cancellation)
          const index = nextIndex++
          if (index >= items.length) return
          const item = items[index]
          if (item === undefined) throw new Error('Code Index 工作队列缺少任务')
          try {
            results.set(index, { value: await work(item, index) })
          } catch (error) {
            stopped = true
            throw error
          }
          throwIfCancelled(cancellation)
          await yieldToEventLoop()
        }
      }
    )
    await Promise.all(workers)
    return Object.freeze(items.map((_, index) => {
      const entry = results.get(index)
      if (!entry) throw new Error('Code Index 工作队列未产生完整结果')
      return entry.value
    }))
  }
}

export function throwIfCodeIndexBuildCancelled(
  cancellation: CodeIndexWorkCancellation
): void {
  throwIfCancelled(cancellation)
}

function throwIfCancelled(cancellation: CodeIndexWorkCancellation): void {
  if (cancellation.abortSignal?.aborted || cancellation.isAborted?.()) {
    throw new CodeIndexBuildCancelledError()
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
