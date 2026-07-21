/**
 * 缓存诊断 — wire 级 first-diff + cache_read 跌落 + expectedReuse 对照。
 *
 * 职责：
 * 1. 记录每次请求的 WireSnapshot，与上一轮做分段 first-diff
 * 2. epoch 管理：压缩 / fallback / 工具集变化等切换后首轮不告警
 * 3. cache_read_tokens 跌落检测
 * 4. expectedReuse（前缀字节估算）与 actualCached（usage）对照
 */
import type { WireSnapshot, MessageSegmentFingerprint } from './requestFingerprint'
import { isLegacyWireSnapshot, upgradeLegacyWireSnapshot } from './requestFingerprint'

/** 分段差分命中的字段名 */
export type PrefixDiffPart =
  | 'model'
  | 'tools'
  | 'role'
  | 'content'
  | 'reasoning_content'
  | 'tool_calls'
  | 'tool_result'
  | 'unknown'

/** 前缀差分诊断（含量级） */
export interface PrefixDiffDiagnostic {
  epochId: string
  firstDiffIndex: number | null
  firstDiffPart: PrefixDiffPart | null
  previousMessageCount: number
  currentMessageCount: number
  commonPrefixBytes: number
  invalidatedSuffixBytes: number
  estimatedInvalidatedTokens: number
  /** usage 回填后才有；对照 expectedReuse */
  actualCacheReadTokens?: number
  /** 公共前缀估算 token（~bytes/4） */
  expectedReuseTokens: number
  /** 压缩摘要请求等已知预期 miss */
  expectedMiss: boolean
}

/** 缓存诊断结果 */
export interface CacheDiagnosticResult {
  cacheBreakDetected: boolean
  reason?: CacheBreakReason
  suggestion?: string
  /** 当前 cache_read_tokens 相比上轮的变化量 */
  tokenDelta?: number
  /** 首条不一致消息下标；null 表示纯追加或首轮 */
  firstDiffIndex?: number | null
  /** 变化落在哪一段字段 */
  firstDiffPart?: PrefixDiffPart | null
  /** 当前 epoch 标识 */
  epochId?: string
  /** 完整前缀差分（有量级时附带） */
  prefixDiff?: PrefixDiffDiagnostic
  /** expectedReuseTokens vs actualCacheReadTokens 对照 */
  expectedReuseTokens?: number
  actualCacheReadTokens?: number
}

type CacheBreakReason =
  | 'prefix_diff_detected'
  | 'significant_cache_read_drop'
  | 'prompt_cache_key_unsupported'
  | 'reasoning_content_unsupported'
  | 'clear_thinking_unsupported'
  | 'expected_reuse_mismatch'

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
/** 字节→token 粗估（UTF-8 约 4 bytes/token） */
const BYTES_PER_TOKEN = 4
/**
 * expectedReuse 与 actualCached 偏差超过此比例且绝对差够大时记 mismatch。
 * 仅作观测告警，不改变请求路径。
 */
const REUSE_MISMATCH_RATIO = 0.35
const REUSE_MISMATCH_MIN_TOKENS = 800

/** 跨回合持久化的诊断状态（只含哈希，不含明文） */
export interface DiagnosticPersistState {
  epochId: string
  epochReason: EpochReason
  lastSnapshot: WireSnapshot | null
  lastCacheReadTokens: number
}

export interface RecordWireSnapshotOptions {
  /** 压缩摘要请求等：必然全量 miss，不记作 cacheBreak */
  expectedMiss?: boolean
}

/**
 * 缓存诊断跟踪器。
 *
 * 使用方式：
 * 1. 每次 API 请求边界调用 recordWireSnapshot()
 * 2. 每次 API 响应后调用 checkCacheReadDrop() / correlateUsage()
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
  /** 最近一次 prefixDiff（usage 回填对照用） */
  private lastPrefixDiff: PrefixDiffDiagnostic | null = null
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
    this.lastPrefixDiff = null
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
   * 记录本次请求的 WireSnapshot 并计算分段 first-diff。
   * expectedMiss（压缩摘要）时标记但不告警。
   */
  recordWireSnapshot(
    snapshot: WireSnapshot,
    options?: RecordWireSnapshotOptions
  ): CacheDiagnosticResult {
    this.currentSnapshot = snapshot
    const expectedMiss = options?.expectedMiss === true

    let result: CacheDiagnosticResult
    if (!this.hasSnapshotInEpoch || !this.previousSnapshot) {
      this.hasSnapshotInEpoch = true
      this.previousSnapshot = snapshot
      const prefixDiff = emptyPrefixDiff(this.epochId, snapshot, expectedMiss)
      this.lastPrefixDiff = prefixDiff
      result = {
        cacheBreakDetected: false,
        firstDiffIndex: null,
        firstDiffPart: null,
        epochId: this.epochId,
        prefixDiff,
        expectedReuseTokens: prefixDiff.expectedReuseTokens
      }
    } else {
      const prefixDiff = computePrefixDiff(this.previousSnapshot, snapshot, {
        epochId: this.epochId,
        expectedMiss
      })
      this.previousSnapshot = snapshot
      this.lastPrefixDiff = prefixDiff

      if (expectedMiss || prefixDiff.firstDiffIndex === null) {
        result = {
          cacheBreakDetected: false,
          firstDiffIndex: prefixDiff.firstDiffIndex,
          firstDiffPart: prefixDiff.firstDiffPart,
          epochId: this.epochId,
          prefixDiff,
          expectedReuseTokens: prefixDiff.expectedReuseTokens
        }
      } else {
        const partLabel = prefixDiff.firstDiffPart ?? 'unknown'
        const idx = prefixDiff.firstDiffIndex
        result = {
          cacheBreakDetected: true,
          reason: 'prefix_diff_detected',
          suggestion:
            idx < 0 || partLabel === 'model' || partLabel === 'tools'
              ? `前缀缓存在 ${partLabel} 处发生破坏，整段前缀将无法命中缓存（约作废 ${prefixDiff.estimatedInvalidatedTokens} tokens）。`
              : `前缀缓存在 messages[${idx}] 的 ${partLabel} 处发生破坏，该位置及之后约作废 ${prefixDiff.estimatedInvalidatedTokens} tokens。`,
          firstDiffIndex: prefixDiff.firstDiffIndex,
          firstDiffPart: prefixDiff.firstDiffPart,
          epochId: this.epochId,
          prefixDiff,
          expectedReuseTokens: prefixDiff.expectedReuseTokens
        }
      }
    }

    this.persistCallback?.(this.getPersistState())
    return result
  }

  /** 最近一轮 WireSnapshot（供观测/单测） */
  getLastWireSnapshot(): WireSnapshot | null {
    return this.currentSnapshot
  }

  /**
   * 检测 cache_read_tokens 是否显著下降（在收到 usage 事件后调用）。
   */
  checkCacheReadDrop(cachedTokens: number): CacheDiagnosticResult {
    if (this.lastCacheReadTokens > 0) {
      const tokenDrop = this.lastCacheReadTokens - cachedTokens
      const dropRatio = tokenDrop / this.lastCacheReadTokens

      if (dropRatio > SIGNIFICANT_DROP_RATIO && tokenDrop > MIN_CACHE_MISS_TOKENS) {
        const result: CacheDiagnosticResult = {
          cacheBreakDetected: true,
          reason: 'significant_cache_read_drop',
          suggestion: `缓存命中率显著下降（${Math.round(dropRatio * 100)}%，-${tokenDrop} tokens）。可能原因：上下文压缩、消息格式变化、或 API 侧缓存过期。`,
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

  /**
   * 将本轮 actualCacheRead 与上一快照的 expectedReuse 对照。
   * 偏差过大时产出观测告警（不改变请求路径）。
   */
  correlateUsage(actualCacheReadTokens: number): CacheDiagnosticResult {
    const prefixDiff = this.lastPrefixDiff
    if (!prefixDiff || prefixDiff.expectedMiss) {
      return { cacheBreakDetected: false, epochId: this.epochId }
    }

    prefixDiff.actualCacheReadTokens = actualCacheReadTokens
    const expected = prefixDiff.expectedReuseTokens
    const actual = actualCacheReadTokens
    const delta = expected - actual
    const ratio = expected > 0 ? delta / expected : 0

    if (
      expected >= REUSE_MISMATCH_MIN_TOKENS &&
      delta > REUSE_MISMATCH_MIN_TOKENS &&
      ratio > REUSE_MISMATCH_RATIO
    ) {
      return {
        cacheBreakDetected: true,
        reason: 'expected_reuse_mismatch',
        suggestion: `预期可复用约 ${expected} tokens，实际 cache_read 仅 ${actual}（偏差 ${Math.round(ratio * 100)}%）。`,
        epochId: this.epochId,
        prefixDiff,
        expectedReuseTokens: expected,
        actualCacheReadTokens: actual
      }
    }

    return {
      cacheBreakDetected: false,
      epochId: this.epochId,
      prefixDiff,
      expectedReuseTokens: expected,
      actualCacheReadTokens: actual
    }
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

  /** 从持久化状态恢复（loop 重建后调用）；兼容旧版 semanticMessageHashes 快照 */
  restoreFromState(state: DiagnosticPersistState): void {
    this.epochId = state.epochId
    this.epochReason = state.epochReason
    const snap = normalizePersistedSnapshot(state.lastSnapshot)
    this.previousSnapshot = snap
    this.currentSnapshot = snap
    this.lastCacheReadTokens = state.lastCacheReadTokens
    this.hasSnapshotInEpoch = snap !== null
    this.lastPrefixDiff = null
    const match = state.epochId.match(/^epoch_(\d+)$/)
    this.epochCounter = match ? parseInt(match[1], 10) : 0
  }
}

function normalizePersistedSnapshot(raw: WireSnapshot | null | unknown): WireSnapshot | null {
  if (!raw) return null
  if (isLegacyWireSnapshot(raw)) return upgradeLegacyWireSnapshot(raw)
  if (
    typeof raw === 'object' &&
    Array.isArray((raw as WireSnapshot).messages)
  ) {
    return raw as WireSnapshot
  }
  return null
}

function emptyPrefixDiff(
  epochId: string,
  current: WireSnapshot,
  expectedMiss: boolean
): PrefixDiffDiagnostic {
  const prefixBytes = sumMessageBytes(current.messages)
  return {
    epochId,
    firstDiffIndex: null,
    firstDiffPart: null,
    previousMessageCount: 0,
    currentMessageCount: current.messages.length,
    commonPrefixBytes: 0,
    invalidatedSuffixBytes: 0,
    estimatedInvalidatedTokens: 0,
    expectedReuseTokens: bytesToTokens(prefixBytes),
    expectedMiss
  }
}

/**
 * 计算两个 WireSnapshot 之间的分段前缀差分。
 * 纯追加（前一次 messages 是后一次的前缀）返回 firstDiffIndex=null。
 * toolsHash / model 变化视为 index 0 + 对应 firstDiffPart。
 */
export function computePrefixDiff(
  prev: WireSnapshot,
  curr: WireSnapshot,
  opts: { epochId: string; expectedMiss?: boolean }
): PrefixDiffDiagnostic {
  const expectedMiss = opts.expectedMiss === true
  const base = {
    epochId: opts.epochId,
    previousMessageCount: prev.messages.length,
    currentMessageCount: curr.messages.length,
    expectedMiss
  }

  if (prev.model !== curr.model) {
    return {
      ...base,
      firstDiffIndex: 0,
      firstDiffPart: 'model',
      commonPrefixBytes: 0,
      invalidatedSuffixBytes: prev.bodyBytes || sumMessageBytes(prev.messages),
      estimatedInvalidatedTokens: bytesToTokens(prev.bodyBytes || sumMessageBytes(prev.messages)),
      expectedReuseTokens: 0
    }
  }

  if (prev.toolsHash !== curr.toolsHash) {
    return {
      ...base,
      firstDiffIndex: 0,
      firstDiffPart: 'tools',
      commonPrefixBytes: 0,
      invalidatedSuffixBytes: prev.bodyBytes || sumMessageBytes(prev.messages),
      estimatedInvalidatedTokens: bytesToTokens(prev.bodyBytes || sumMessageBytes(prev.messages)),
      expectedReuseTokens: 0
    }
  }

  const prevMsgs = prev.messages
  const currMsgs = curr.messages
  const sharedLen = Math.min(prevMsgs.length, currMsgs.length)
  let commonPrefixBytes = 0

  for (let i = 0; i < sharedLen; i++) {
    if (prevMsgs[i].whole === currMsgs[i].whole) {
      commonPrefixBytes += prevMsgs[i].bytes
      continue
    }
    const part = locateSegmentDiff(prevMsgs[i], currMsgs[i])
    const invalidatedSuffixBytes = sumBytesFrom(prevMsgs, i)
    return {
      ...base,
      firstDiffIndex: i,
      firstDiffPart: part,
      commonPrefixBytes,
      invalidatedSuffixBytes,
      estimatedInvalidatedTokens: bytesToTokens(invalidatedSuffixBytes),
      expectedReuseTokens: bytesToTokens(commonPrefixBytes)
    }
  }

  if (currMsgs.length < prevMsgs.length) {
    const invalidatedSuffixBytes = sumBytesFrom(prevMsgs, sharedLen)
    return {
      ...base,
      firstDiffIndex: sharedLen,
      firstDiffPart: 'content',
      commonPrefixBytes,
      invalidatedSuffixBytes,
      estimatedInvalidatedTokens: bytesToTokens(invalidatedSuffixBytes),
      expectedReuseTokens: bytesToTokens(commonPrefixBytes)
    }
  }

  // 纯追加或完全相同
  return {
    ...base,
    firstDiffIndex: null,
    firstDiffPart: null,
    commonPrefixBytes,
    invalidatedSuffixBytes: 0,
    estimatedInvalidatedTokens: 0,
    expectedReuseTokens: bytesToTokens(commonPrefixBytes)
  }
}

function locateSegmentDiff(
  prev: MessageSegmentFingerprint,
  curr: MessageSegmentFingerprint
): PrefixDiffPart {
  if (!prev.role && !curr.role) return 'unknown'
  if (prev.role !== curr.role) return 'role'
  if (prev.content !== curr.content) return 'content'
  if (prev.reasoningContent !== curr.reasoningContent) return 'reasoning_content'
  if (prev.toolCalls !== curr.toolCalls) return 'tool_calls'
  if (prev.toolResult !== curr.toolResult) return 'tool_result'
  return 'unknown'
}

function sumMessageBytes(msgs: MessageSegmentFingerprint[]): number {
  return sumBytesFrom(msgs, 0)
}

function sumBytesFrom(msgs: MessageSegmentFingerprint[], from: number): number {
  let total = 0
  for (let i = from; i < msgs.length; i++) {
    total += msgs[i].bytes
  }
  return total
}

function bytesToTokens(bytes: number): number {
  if (bytes <= 0) return 0
  return Math.ceil(bytes / BYTES_PER_TOKEN)
}
