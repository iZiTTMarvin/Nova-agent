/**
 * 主进程 event-loop lag 采样类型（main / renderer / 单测共享）
 *
 * 与 renderer 侧 streamingPerf.snapshot 对齐：提供 snapshot / reset 只读观测 API。
 */

export interface MainLoopLagSnapshot {
  enabled: boolean
  /** 采样分辨率（ms），与 monitorEventLoopDelay resolution 一致 */
  resolutionMs: number
  /** 自上次 reset 或启动以来的采样次数（histogram 内部计数） */
  sampleCount: number
  p50Ms: number
  p99Ms: number
  maxMs: number
}

export interface MainLoopLagApi {
  snapshot: () => MainLoopLagSnapshot
  reset: () => void
}

/** renderer 经 IPC 桥接的 API（异步） */
export interface RendererMainLoopLagApi {
  snapshot: () => Promise<MainLoopLagSnapshot>
  reset: () => Promise<void>
}
