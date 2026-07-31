/**
 * 两层信号量：进程级全局 + per-run。
 * agent() 内部串行 acquire；parallel() 本身不节流。
 */
import os from 'node:os'

export interface Semaphore {
  /** 在持有许可期间执行 fn；结束后释放 */
  run<T>(fn: () => Promise<T>): Promise<T>
  /** 当前活跃数（测试用） */
  readonly active: number
  readonly max: number
}

export function makeSemaphore(max: number): Semaphore {
  const limit = Math.max(1, max)
  let active = 0
  const queue: Array<() => void> = []

  const release = () => {
    active--
    const next = queue.shift()
    if (next) next()
  }

  return {
    get active() {
      return active
    },
    get max() {
      return limit
    },
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const attempt = () => {
          active++
          fn().then(
            (value) => {
              release()
              resolve(value)
            },
            (err) => {
              release()
              reject(err)
            }
          )
        }
        if (active < limit) attempt()
        else queue.push(attempt)
      })
    }
  }
}

function cpuCount(): number {
  const n = os.cpus().length
  return n > 0 ? n : 4
}

/** 进程级默认上限：min(16, 2 * cpuCount) */
export function defaultGlobalMax(): number {
  return Math.min(16, 2 * cpuCount())
}

let globalSem: Semaphore | undefined

/** 进程生命周期内复用的全局信号量 */
export function getGlobalSemaphore(max?: number): Semaphore {
  if (!globalSem) {
    globalSem = makeSemaphore(max ?? defaultGlobalMax())
  }
  return globalSem
}

/** 测试辅助：重置全局信号量 */
export function _resetGlobalSemaphoreForTests(max?: number): void {
  globalSem = makeSemaphore(max ?? defaultGlobalMax())
}

/**
 * 为单次 run 创建 per-run 信号量，上限 ≤ global。
 * agent() 应先 acquire per-run，再 acquire global（或嵌套 run）。
 */
export function makeRunSemaphore(maxConcurrentAgents?: number): {
  runSem: Semaphore
  globalSem: Semaphore
} {
  const global = getGlobalSemaphore()
  const requested = maxConcurrentAgents ?? global.max
  const max = Math.max(1, Math.min(requested, global.max))
  return { runSem: makeSemaphore(max), globalSem: global }
}
