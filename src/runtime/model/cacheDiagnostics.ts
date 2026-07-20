/**
 * 缓存诊断模块 — wire 级 first-diff + cache_read 跌落检测。
 *
 * 核心职责：
 * 1. 记录每次请求的 WireSnapshot（语义指纹），与上一轮做 first-diff 定位前缀破坏点
 * 2. epoch 管理：压缩 / fallback / 工具集变化等事件切换 epoch，首轮不告警
 * 3. cache_read_tokens 跌落检测（保留原有能力）
 *
 * 不再做逻辑上下文（system prompt / tool schema）的基线比较——
 * 这些变化已被 WireSnapshot 的 semanticMessageHashes / toolsHash 覆盖。
 */
import type { WireSnapshot } from './requestFingerprint'

/** 缓存诊断结果 */
export interface CacheDiagnosticResult {
  cacheBreakDetected: boolean
  reason?: CacheBreakReason
  suggestion?: string
  /** 当前 cache_read_tokens 相比上轮的变化量 */
  tokenDelta?: number
  /** 首条不一致消息下标（相同 epoch 内与上一轮比对）；null 表示纯追加或首轮 */
  firstDiffIndex?: number | null
  /** 当前 epoch 标识 */
  epochId?: string
}

type CacheBreakReason =
  | 'prefix_diff_detected'
  | 'significant_cache_read_drop'
  | 'prompt_cache_key_unsupported'

/** epoch 切换原因 */
export type EpochReason =
  | 'compaction'
  | 'model_switch'
  | 'toolset_change'
  | 'provider_capability_downgrade'
  | 'session_init'

/** cache_read_tokens 下降超过此比例视为显著（5%） */
const SIGNIFICANT_DROP_RATIO = 0.05
/** cache_read_tokens 下降的最小绝对阈值，避免小数值误报 */
const MIN_CACHE_MISS_TOKENS = 500

/** 跨回合持久化的诊断状态（只含哈希，不含明文） */
export interface DiagnosticPersistState {
  epochId: string
  epochReason: EpochReason
  lastSnapshot: WireSnapshot | null
  lastCacheReadTokens: number
}

/**
 * 缓存诊断跟踪器
 *
 * 使用方式：
 * 1. 每次 API 请求边界调用 recordWireSnapshot()
 * 2. 每次 API 响应后调用 checkCacheReadDrop()
 * 3. 压缩 / fallback / 工具集变化时调用 bumpEpoch()
 * 4. 跨回合持久化：getPersistState() / restoreFromState()
 */
export class CacheDiagnostics {
  private epochId: string = 'epoch_0'
  private epochReason: EpochReason = 'session_init'
  private epochCounter = 0
  /** 上一轮 WireSnapshot（同 epoch 内用于 first-diff） */
  private previousSnapshot: WireSnapshot | null = null
  /** 当前轮 WireSnapshot */
  private currentSnapshot: WireSnapshot | null = null
  /** 上一轮的 cache_read_input_tokens */
  private lastCacheReadTokens = 0
  /** epoch 切换后是否已产出过快照（首轮不告警） */
  private hasSnapshotInEpoch = false
  /** 快照变化时的持久化回调（由外部注入，loop 重建后重新绑定） */
  private persistCallback: ((state: DiagnosticPersistState) => void) | null = null

  /** 设置持久化回调，每次快照更新后触发 */
  setPersistCallback(cb: ((state: DiagnosticPersistState) => void) | null): void {
    this.persistCallback = cb
  }

  /**
   * 切换 epoch（压缩 / fallback / 工具集变化等）。
   * 切换后首轮不产生 first-diff 告警。
   */
  bumpEpoch(reason: EpochReason): void {
    this.epochCounter++
    this.epochId = `epoch_${this.epochCounter}`
    this.epochReason = reason
    this.previousSnapshot = null
    this.currentSnapshot = null
    this.hasSnapshotInEpoch = false
    this.lastCacheReadTokens = 0
  }

  /** 当前 epoch 标识 */
  getEpochId(): string {
    return this.epochId
  }

  /** 当前 epoch 切换原因 */
  getEpochReason(): EpochReason {
    return this.epochReason
  }

  /**
   * 记录本次请求的 WireSnapshot 并计算 first-diff。
   * 返回诊断结果（含 firstDiffIndex）。
   */
  recordWireSnapshot(snapshot: WireSnapshot): CacheDiagnosticResult {
    this.currentSnapshot = snapshot

    let result: CacheDiagnosticResult
    if (!this.hasSnapshotInEpoch || !this.previousSnapshot) {
      this.hasSnapshotInEpoch = true
      this.previousSnapshot = snapshot
      result = { cacheBreakDetected: false, firstDiffIndex: null, epochId: this.epochId }
    } else {
      const firstDiffIndex = computeFirstDiffIndex(this.previousSnapshot, snapshot)
      this.previousSnapshot = snapshot

      if (firstDiffIndex !== null) {
        result = {
          cacheBreakDetected: true,
          reason: 'prefix_diff_detected',
          suggestion: `前缀缓存在 messages[${firstDiffIndex}] 处发生破坏，该位置及之后的内容将无法命中缓存。`,
          firstDiffIndex,
          epochId: this.epochId
        }
      } else {
        result = { cacheBreakDetected: false, firstDiffIndex: null, epochId: this.epochId }
      }
    }

    this.persistCallback?.(this.getPersistState())
    return result
  }

  /** 最近一次 WireSnapshot（供观测/单测） */
  getLastWireSnapshot(): WireSnapshot | null {
    return this.currentSnapshot
  }

  /**
   * 检查 cache_read_tokens 是否显著下降（在收到 usage 事件后调用）。
   * 保留原有跌落检测能力，不再做 system/tool 哈希比较。
   */
  checkCacheReadDrop(cachedTokens: number): CacheDiagnosticResult {
    if (this.lastCacheReadTokens > 0) {
      const tokenDrop = this.lastCacheReadTokens - cachedTokens
      const dropRatio = tokenDrop / this.lastCacheReadTokens

      if (dropRatio > SIGNIFICANT_DROP_RATIO && tokenDrop > MIN_CACHE_MISS_TOKENS) {
        const result: CacheDiagnosticResult = {
          cacheBreakDetected: true,
          reason: 'significant_cache_read_drop',
          suggestion: `缓存命中率显著下降（${Math.round(dropRatio * 100)}%，${tokenDrop} tokens）。可能原因：上下文压缩、消息格式变化、或 API 侧缓存过期。`,
          tokenDelta: -tokenDrop,
          epochId: this.epochId
        }
        this.lastCacheReadTokens = cachedTokens
        return result
      }
    }

    this.lastCacheReadTokens = cachedTokens
    return { cacheBreakDetected: false, epochId: this.epochId }
  }

  /** 导出跨回合持久化状态 */
  getPersistState(): DiagnosticPersistState {
    return {
      epochId: this.epochId,
      epochReason: this.epochReason,
      lastSnapshot: this.currentSnapshot,
      lastCacheReadTokens: this.lastCacheReadTokens
    }
  }

  /** 从持久化状态恢复（loop 重建后调用） */
  restoreFromState(state: DiagnosticPersistState): void {
    this.epochId = state.epochId
    this.epochReason = state.epochReason
    this.previousSnapshot = state.lastSnapshot
    this.currentSnapshot = state.lastSnapshot
    this.lastCacheReadTokens = state.lastCacheReadTokens
    this.hasSnapshotInEpoch = state.lastSnapshot !== null
    const match = state.epochId.match(/^epoch_(\d+)$/)
    this.epochCounter = match ? parseInt(match[1], 10) : 0
  }
}

/**
 * 计算两个 WireSnapshot 之间的 firstDiffIndex。
 * 纯追加（前一次 messages 是后一次的前缀）返回 null。
 * toolsHash 或 model 变化视为 index 0 处的 diff。
 */
function computeFirstDiffIndex(prev: WireSnapshot, curr: WireSnapshot): number | null {
  if (prev.model !== curr.model || prev.toolsHash !== curr.toolsHash) {
    return 0
  }

  const prevHashes = prev.semanticMessageHashes
  const currHashes = curr.semanticMessageHashes

  if (currHashes.length < prevHashes.length) {
    return currHashes.length
  }

  for (let i = 0; i < prevHashes.length; i++) {
    if (prevHashes[i] !== currHashes[i]) {
      return i
    }
  }

  return null
}
