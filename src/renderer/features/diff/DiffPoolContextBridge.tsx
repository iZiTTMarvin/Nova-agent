/**
 * diff 运行时提供者（懒加载 chunk）
 *
 * 本文件是 @pierre/diffs 依赖链进入首屏包的唯一入口，因此单独成 chunk：
 * 没有 diff 在渲染时，首屏既不下载 pierre 组件层与 shiki 引擎，
 * 也不创建 worker 池。
 *
 * 为什么用裸 WorkerPoolContext.Provider 而不用官方的 WorkerPoolContextProvider：
 * 官方那个在挂载的 useState 初始化器里就创建池（挂载即付出 worker + wasm 成本），
 * 且卸载时 `instanceCount === 0` 会 terminate 并重置单例。这里改为：
 *   - 池在我们自己的 effect 里创建，时机由「真的有 diff 要渲染」决定；
 *   - 用裸 Provider 只注入 context value，不含任何 terminate 逻辑。
 *
 * 三条来自 @pierre/diffs 的硬语义（读自 node_modules/@pierre/diffs/dist/）：
 *
 * 1. `worker/getOrCreateWorkerPoolSingleton.js:5` — `workerPoolSingleton ??= new WorkerPoolManager(...)`，
 *    模块级单例，**首个调用者配置永久胜出**。故下面配置全局唯一，不可按调用点差异化。
 * 2. `worker/WorkerPoolManager.js:63` — 构造函数即 `queueInitialization()`，
 *    会按 poolSize 建 worker 并解析主题/语言包。故必须懒创建。
 * 3. `react/WorkerPoolContext.js:24-28` — 官方 Provider 卸载会 terminate 池。
 *    本模块不使用它、也不调用 terminateWorkerPoolSingleton，故池只创建一次、全程存活。
 *
 * 池是模块级单例：多处 diff 同时挂载时各自调用 getOrCreate，
 * 拿到的是同一个池，不会重复创建 worker。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { WorkerPoolContext } from '@pierre/diffs/react'
import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker'
// Vite 专有的 `?worker&url`：把 worker 打成独立资源并给出 URL。
// 与迁移前 renderer/main.tsx 写法完全一致，只是搬到了懒 chunk 内。
import DiffWorkerUrl from '@pierre/diffs/worker/worker.js?worker&url'

/**
 * 池配置：整场会话唯一，不可按调用点差异化（见文件头语义 1）。
 */
const POOL_OPTIONS = {
  poolSize: 2,
  workerFactory: () => new Worker(DiffWorkerUrl, { type: 'module' })
} as const

const HIGHLIGHTER_OPTIONS = {
  theme: { light: 'pierre-light', dark: 'pierre-dark' },
  lineDiffType: 'word-alt',
  preferredHighlighter: 'shiki-wasm'
} as const

export function DiffPoolContextBridge({ children }: { children: ReactNode }): ReactNode {
  const [pool, setPool] = useState<ReturnType<typeof getOrCreateWorkerPoolSingleton>>()

  useEffect(() => {
    // 无 Worker 的环境（如 jsdom）不建池：context 保持 undefined，pierre 走无 worker 降级
    if (typeof Worker === 'undefined') return
    setPool(
      getOrCreateWorkerPoolSingleton({
        poolOptions: POOL_OPTIONS,
        highlighterOptions: HIGHLIGHTER_OPTIONS
      })
    )
  }, [])

  // pool 尚未就绪的那一帧 value 为 undefined（与无 Provider 时同值）：
  // pierre 会走无 worker 降级而不是崩溃，下一帧拿到池后正常高亮。
  return <WorkerPoolContext.Provider value={pool}>{children}</WorkerPoolContext.Provider>
}

export default DiffPoolContextBridge
