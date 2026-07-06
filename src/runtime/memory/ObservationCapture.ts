/**
 * ObservationCapture — 工具轨迹采集（纯逻辑，零 LLM，内存 working buffer）
 *
 * 默认由 memoryCaptureEnabled 门控；P2-2 仅缓冲不落盘。
 */
import { createHash } from 'node:crypto'
import { resolveToolArg } from '../tools/toolArgResolver'
import {
  filterPrivacyText,
  filterToolPayload,
  isSensitiveFilePath,
  type PrivacyFilterOptions
} from './PrivacyFilter'

/** 单条 observation（working 缓冲条目） */
export interface MemoryObservation {
  id: string
  sessionId: string
  messageId: string
  toolCallId: string
  toolName: string
  title: string
  facts: string[]
  filesTouched: string[]
  fingerprint: string
  capturedAt: number
  hadSensitive: boolean
}

export interface ObservationCaptureOptions {
  privacyFilter?: PrivacyFilterOptions
  /** 同 fingerprint 去重窗口，默认 5 分钟 */
  dedupeWindowMs?: number
  /** working buffer 条目上限，超出时触发 onBufferOverflow 或丢弃最旧 */
  maxBufferSize?: number
  /** 未配对 tool_call 的 TTL，默认 10 分钟 */
  pendingTtlMs?: number
  /**
   * buffer 超限回调（主进程用于 sync drain + fire-and-forget 落盘）。
   * 须在 append 之后同步触发，禁止在 setImmediate 内再读 buffer。
   */
  onBufferOverflow?: (sessionId: string) => void
  /** 注入时钟（单测用） */
  now?: () => number
}

interface PendingToolCall {
  sessionId: string
  messageId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  filesTouched: string[]
  filteredInput: string
  startedAt: number
}

const DEFAULT_DEDUPE_MS = 5 * 60 * 1000
const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000
/** 默认 working buffer 上限（超出触发 flush 或丢最旧） */
export const DEFAULT_MAX_BUFFER_SIZE = 200
const TITLE_MAX_CHARS = 80

/** 标题展示长度上限（须在隐私过滤之后调用） */
export function truncateObservationTitle(title: string, maxChars = TITLE_MAX_CHARS): string {
  const trimmed = title.trim()
  if (trimmed.length <= maxChars) {
    return trimmed
  }
  return `${trimmed.slice(0, maxChars - 1)}…`
}

let observationIdSeq = 0

function nextObservationId(): string {
  observationIdSeq += 1
  return `obs_${observationIdSeq}`
}

/** 单测重置 id 序列 */
export function resetObservationIdSeqForTests(): void {
  observationIdSeq = 0
}

/**
 * 从工具参数提取可能触及的文件路径
 */
export function extractFilesTouched(
  toolName: string,
  args: Record<string, unknown>
): string[] {
  const paths = new Set<string>()
  const primary = resolveToolArg(args, 'path')
  if (primary) {
    paths.add(primary)
  }
  // write/edit 可能带 old_string 以外的第二路径较少；bash 不猜路径
  if (toolName === 'write' || toolName === 'edit') {
    const alt = args.file_path ?? args.filePath
    if (typeof alt === 'string' && alt.trim()) {
      paths.add(alt.trim())
    }
  }
  return [...paths].filter((p) => !isSensitiveFilePath(p))
}

/**
 * 零 LLM 标题：工具名 + 完整 path/command（不在此处截断；截断在隐私过滤之后）
 */
export function buildObservationTitle(
  toolName: string,
  args: Record<string, unknown>
): string {
  const path = resolveToolArg(args, 'path')
  if (path) {
    return `${toolName} ${path}`
  }
  const cmd = resolveToolArg(args, 'command')
  if (cmd) {
    const firstLine = cmd.split('\n')[0]?.trim() ?? cmd
    return `${toolName} ${firstLine}`
  }
  return toolName
}

/** 先隐私过滤完整标题，再截断展示（避免截断后密钥残片逃逸） */
export interface FilteredObservationTitle {
  title: string
  hadSensitive: boolean
}

export function buildFilteredObservationTitle(
  toolName: string,
  args: Record<string, unknown>,
  privacyOptions?: PrivacyFilterOptions
): FilteredObservationTitle {
  const rawTitle = buildObservationTitle(toolName, args)
  const filtered = filterPrivacyText(rawTitle, privacyOptions)
  if (filtered.shouldDiscard) {
    return { title: toolName, hadSensitive: filtered.hadSensitive }
  }
  const text = filtered.text || toolName
  return {
    title: truncateObservationTitle(text),
    hadSensitive: filtered.hadSensitive
  }
}

/** 取 output 前 3 行非空作为 facts */
export function extractObservationFacts(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
}

export function computeObservationFingerprint(
  toolName: string,
  filteredInput: string,
  filteredOutput: string,
  filesTouched: string[]
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        toolName,
        filteredInput,
        filteredOutput,
        filesTouched: [...filesTouched].sort()
      })
    )
    .digest('hex')
}

export class ObservationCapture {
  private readonly dedupeWindowMs: number
  private readonly pendingTtlMs: number
  private readonly maxBufferSize: number
  private onBufferOverflow: ((sessionId: string) => void) | undefined
  private readonly privacyOptions: PrivacyFilterOptions | undefined
  private readonly now: () => number

  /** sessionId → working buffer */
  private readonly buffers = new Map<string, MemoryObservation[]>()
  /** toolCallId → 待配对 tool_result */
  private readonly pending = new Map<string, PendingToolCall>()
  /** fingerprint → 最近采集时间 */
  private readonly recentFingerprints = new Map<string, number>()

  constructor(options: ObservationCaptureOptions = {}) {
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_MS
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS
    this.maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE
    this.onBufferOverflow = options.onBufferOverflow
    this.privacyOptions = options.privacyFilter
    this.now = options.now ?? (() => Date.now())
  }

  onToolCall(params: {
    sessionId: string
    messageId: string
    toolCallId: string
    toolName: string
    args: Record<string, unknown>
  }): void {
    const pathArg = resolveToolArg(params.args, 'path')
    if (pathArg && isSensitiveFilePath(pathArg)) {
      return
    }

    const rawInput = JSON.stringify(params.args ?? {})
    const filesTouched = extractFilesTouched(params.toolName, params.args)

    const filtered = filterToolPayload(rawInput, '', filesTouched, this.privacyOptions)
    if (filtered.shouldDiscard) {
      return
    }

    this.pending.set(params.toolCallId, {
      sessionId: params.sessionId,
      messageId: params.messageId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      args: params.args,
      filesTouched,
      filteredInput: filtered.filteredInput,
      startedAt: this.now()
    })
  }

  onToolResult(params: {
    sessionId: string
    messageId: string
    toolCallId: string
    toolName: string
    result: string
  }): void {
    const pending = this.pending.get(params.toolCallId)
    this.pending.delete(params.toolCallId)
    if (!pending) {
      return
    }

    const filtered = filterToolPayload(
      pending.filteredInput,
      params.result,
      pending.filesTouched,
      this.privacyOptions
    )
    if (filtered.shouldDiscard) {
      return
    }

    const fingerprint = computeObservationFingerprint(
      params.toolName,
      filtered.filteredInput,
      filtered.filteredOutput,
      pending.filesTouched
    )

    if (this.isDuplicate(fingerprint)) {
      return
    }

    const { title, hadSensitive: titleHadSensitive } = buildFilteredObservationTitle(
      params.toolName,
      pending.args,
      this.privacyOptions
    )

    const observation: MemoryObservation = {
      id: nextObservationId(),
      sessionId: params.sessionId,
      messageId: params.messageId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      title,
      facts: extractObservationFacts(filtered.filteredOutput),
      filesTouched: pending.filesTouched,
      fingerprint,
      capturedAt: this.now(),
      hadSensitive: filtered.hadSensitive || titleHadSensitive
    }

    this.recordFingerprint(fingerprint)
    this.appendToBuffer(params.sessionId, observation)
  }

  /** message_end：轮次结束清理孤儿 pending，缓冲保留供 P2-3 drain */
  onMessageEnd(sessionId: string): void {
    this.pruneExpiredFingerprints()
    this.pruneOrphanPendingForSession(sessionId)
    this.pruneExpiredPending()
  }

  getWorkingBuffer(sessionId: string): readonly MemoryObservation[] {
    return this.buffers.get(sessionId) ?? []
  }

  /** P2-3 巩固时取出并清空 */
  drainWorkingBuffer(sessionId: string): MemoryObservation[] {
    const items = this.buffers.get(sessionId) ?? []
    this.buffers.delete(sessionId)
    return items
  }

  /**
   * LLM 提炼专用：读取 working buffer 快照，不清空。
   * 提炼落盘成功后由上层调用 drainWorkingBuffer 消费。
   */
  drainForExtract(sessionId: string): MemoryObservation[] {
    const items = this.buffers.get(sessionId) ?? []
    return [...items]
  }

  clearSession(sessionId: string): void {
    this.buffers.delete(sessionId)
    for (const [id, p] of this.pending) {
      if (p.sessionId === sessionId) {
        this.pending.delete(id)
      }
    }
  }

  clearAll(): void {
    this.buffers.clear()
    this.pending.clear()
    this.recentFingerprints.clear()
  }

  /** 主进程：更新 buffer 溢出回调（同会话多轮 agent 复用 capture 时刷新 workspace 闭包） */
  setOnBufferOverflow(handler: ((sessionId: string) => void) | undefined): void {
    this.onBufferOverflow = handler
  }

  private appendToBuffer(sessionId: string, obs: MemoryObservation): void {
    const list = this.buffers.get(sessionId)
    if (list) {
      list.push(obs)
    } else {
      this.buffers.set(sessionId, [obs])
    }

    const buf = this.buffers.get(sessionId)!
    if (buf.length > this.maxBufferSize) {
      if (this.onBufferOverflow) {
        this.onBufferOverflow(sessionId)
      } else {
        while (buf.length > this.maxBufferSize) {
          buf.shift()
        }
      }
    }
    // 开发冒烟：NOVA_MEMORY_CAPTURE_DEBUG=1 时在主进程控制台打印（不含原始 tool 输出）
    if (process.env.NOVA_MEMORY_CAPTURE_DEBUG === '1') {
      console.debug(
        '[ObservationCapture]',
        JSON.stringify({
          sessionId,
          title: obs.title,
          facts: obs.facts,
          hadSensitive: obs.hadSensitive,
          filesTouched: obs.filesTouched
        })
      )
    }
  }

  private isDuplicate(fingerprint: string): boolean {
    const last = this.recentFingerprints.get(fingerprint)
    if (last === undefined) {
      return false
    }
    return this.now() - last < this.dedupeWindowMs
  }

  private recordFingerprint(fingerprint: string): void {
    this.recentFingerprints.set(fingerprint, this.now())
  }

  private pruneExpiredFingerprints(): void {
    const cutoff = this.now() - this.dedupeWindowMs
    for (const [fp, ts] of this.recentFingerprints) {
      if (ts < cutoff) {
        this.recentFingerprints.delete(fp)
      }
    }
  }

  /** 轮次结束时清掉该会话未配对的 tool_call */
  private pruneOrphanPendingForSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId === sessionId) {
        this.pending.delete(id)
      }
    }
  }

  /** TTL 过期 pending（跨轮次残留） */
  private pruneExpiredPending(): void {
    const cutoff = this.now() - this.pendingTtlMs
    for (const [id, p] of this.pending) {
      if (p.startedAt < cutoff) {
        this.pending.delete(id)
      }
    }
  }
}

/** 按 session 复用的采集器注册表（主进程内存） */
const sessionCaptures = new Map<string, ObservationCapture>()

export function getObservationCaptureForSession(
  sessionId: string,
  options?: ObservationCaptureOptions
): ObservationCapture {
  let cap = sessionCaptures.get(sessionId)
  if (!cap) {
    cap = new ObservationCapture(options)
    sessionCaptures.set(sessionId, cap)
  }
  return cap
}

/** 会话删除后移除采集器注册表条目 */
export function removeObservationCaptureForSession(sessionId: string): void {
  sessionCaptures.delete(sessionId)
}

export function resetObservationCapturesForTests(): void {
  sessionCaptures.clear()
  resetObservationIdSeqForTests()
}
