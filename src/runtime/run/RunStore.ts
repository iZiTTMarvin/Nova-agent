/**
 * RunStore — 原子 snapshot + append-only events
 *
 * 唯一落盘协议（所有状态变化必须走 commitTransaction / commitTransactionBatch）：
 *   单次：next sequence → append event → fsync → atomic replace snapshot
 *   批量：各事件独立 type 与序号，一次写入多行并单次 fsync，快照只原子写一次
 *
 * 启动恢复：读取 snapshot.sequence，重放 events 中更大的合法事件。
 * 损坏末行可忽略；中间损坏不得跳过后续假装一致。
 */
import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteFileSync } from '../storage/atomicFile'
import {
  isTerminalRunStatus,
  isTurnTruncationReason,
  type RunEventRecord,
  type RunSnapshot,
  decodeSubagentRunDispatch,
  decodeSubagentDeliveryBinding
} from '../../shared/run/types'

export interface RunStoreOptions {
  /** 运行快照根目录，通常为 userData/runs */
  runsRoot: string
}

/** runId 安全校验：禁止路径穿越与绝对路径 */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new Error(`非法 runId：${runId}`)
  }
  if (runId.includes('..') || runId.includes('/') || runId.includes('\\')) {
    throw new Error(`非法 runId（含路径分隔）：${runId}`)
  }
}

export class RunStore {
  private readonly runsRoot: string
  private readonly pendingReplay = new Set<string>()

  constructor(opts: RunStoreOptions) {
    this.runsRoot = opts.runsRoot
    if (!fs.existsSync(this.runsRoot)) {
      fs.mkdirSync(this.runsRoot, { recursive: true })
    }
  }

  getRunsRoot(): string {
    return this.runsRoot
  }

  private runDir(runId: string): string {
    assertSafeRunId(runId)
    const dir = path.join(this.runsRoot, runId)
    // 二次校验：解析后必须仍在 runsRoot 下
    const resolved = path.resolve(dir)
    const root = path.resolve(this.runsRoot)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`runId 越界：${runId}`)
    }
    return dir
  }

  private snapshotPath(runId: string): string {
    return path.join(this.runDir(runId), 'snapshot.json')
  }

  private eventsPath(runId: string): string {
    return path.join(this.runDir(runId), 'events.jsonl')
  }

  /**
   * 单次持久化提交。内部走批量入口，保持 event → fsync → snapshot 顺序。
   */
  commitTransaction(
    nextSnapshot: RunSnapshot,
    eventType: string,
    payload?: Record<string, unknown>
  ): RunEventRecord {
    const [event] = this.commitTransactionBatch(nextSnapshot, [
      { type: eventType, sequence: nextSnapshot.sequence, payload }
    ])
    if (!event) {
      throw new Error('commitTransaction 未写入事件')
    }
    return event
  }

  /**
   * 多事件一次落盘：各事件独立 type / sequence，events.jsonl 一次写入 + 单次 fsync，
   * snapshot.json 只原子写一次（sequence 为最后一条）。空数组不写盘。
   */
  commitTransactionBatch(
    nextSnapshot: RunSnapshot,
    events: ReadonlyArray<{
      type: string
      sequence: number
      payload?: Record<string, unknown>
      at?: number
    }>
  ): RunEventRecord[] {
    if (events.length === 0) return []
    assertSafeRunId(nextSnapshot.runId)
    if (this.pendingReplay.has(nextSnapshot.runId)) {
      throw new Error(`run ${nextSnapshot.runId} 的事件尚未完成恢复，拒绝写入旧快照`)
    }
    const last = events[events.length - 1]
    if (last.sequence !== nextSnapshot.sequence) {
      throw new Error(
        `commitTransactionBatch 序号不一致：last=${last.sequence} snapshot=${nextSnapshot.sequence}`
      )
    }
    for (let i = 1; i < events.length; i++) {
      if (events[i].sequence !== events[i - 1].sequence + 1) {
        throw new Error('commitTransactionBatch 序号必须严格连续')
      }
    }

    const dir = this.runDir(nextSnapshot.runId)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const now = Date.now()
    const records: RunEventRecord[] = events.map(event => ({
      sequence: event.sequence,
      runId: nextSnapshot.runId,
      type: event.type,
      at: event.at ?? now,
      payload: event.payload
    }))

    try {
      this.appendEventsFsynced(records)
      atomicWriteFileSync(this.snapshotPath(nextSnapshot.runId), JSON.stringify(nextSnapshot, null, 2))
    } catch (error) {
      this.pendingReplay.add(nextSnapshot.runId)
      throw error
    }
    return records
  }

  /** 追加若干事件后单次 fsync；崩溃时一批同生共死。 */
  private appendEventsFsynced(events: readonly RunEventRecord[]): void {
    if (events.length === 0) return
    const runId = events[0].runId
    const filePath = this.eventsPath(runId)
    const chunk = events.map(event => JSON.stringify(event) + '\n').join('')
    const fd = fs.openSync(filePath, 'a')
    try {
      fs.writeSync(fd, chunk, null, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  /**
   * @deprecated 禁止绕过 commitTransaction；仅保留给迁移/诊断只读场景的兼容包装。
   * 生产路径不得调用。
   */
  saveSnapshot(snapshot: RunSnapshot): void {
    throw new Error('RunStore.saveSnapshot 已禁用：请使用 commitTransaction')
  }

  /**
   * 读取 snapshot；文件不存在或 JSON 损坏返回 null。
   * dispatch/deliveryBinding 解码失败向上抛错：未知协议版本失败关闭，
   * 读取方显式失败，不静默把派遣记录降级为无派遣。
   */
  loadSnapshot(runId: string): RunSnapshot | null {
    return this.pendingReplay.has(runId)
      ? this.loadSnapshotWithReplay(runId)
      : this.readSnapshot(runId)
  }

  private readSnapshot(runId: string): RunSnapshot | null {
    assertSafeRunId(runId)
    const filePath = this.snapshotPath(runId)
    if (!fs.existsSync(filePath)) return null
    let parsed: RunSnapshot
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      parsed = JSON.parse(raw) as RunSnapshot
    } catch (err) {
      console.error(`[RunStore] 读取 snapshot 失败 runId=${runId}:`, err)
      return null
    }
    if (parsed && typeof parsed === 'object' && 'dispatch' in parsed) {
      parsed.dispatch = decodeSubagentRunDispatch(parsed.dispatch) ?? undefined
    }
    if (parsed && typeof parsed === 'object' && 'deliveryBinding' in parsed) {
      parsed.deliveryBinding = decodeSubagentDeliveryBinding(parsed.deliveryBinding) ?? undefined
    }
    return parsed
  }

  /**
   * 读取事件；损坏末行可跳过。
   * 若中间行损坏，停止后续解析并标记 truncated，调用方不得假装完整一致。
   */
  loadEvents(runId: string): { events: RunEventRecord[]; truncatedByCorruption: boolean } {
    assertSafeRunId(runId)
    const filePath = this.eventsPath(runId)
    if (!fs.existsSync(filePath)) return { events: [], truncatedByCorruption: false }
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      const lines = raw.split('\n')
      const events: RunEventRecord[] = []
      let truncatedByCorruption = false
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim()) continue
        try {
          events.push(JSON.parse(line) as RunEventRecord)
        } catch {
          const isLastNonEmpty =
            lines.slice(i + 1).every(l => !l.trim())
          if (isLastNonEmpty) {
            // 末行损坏：可忽略
            break
          }
          // 中间损坏：停止，不得跳过后续
          truncatedByCorruption = true
          break
        }
      }
      return { events, truncatedByCorruption }
    } catch (err) {
      console.error(`[RunStore] 读取 events 失败 runId=${runId}:`, err)
      return { events: [], truncatedByCorruption: true }
    }
  }

  /**
   * 启动恢复：以 snapshot 为基线，重放 sequence 更大的事件。
   * 若事件流中间损坏，只重放到损坏点之前。
   */
  loadSnapshotWithReplay(runId: string): RunSnapshot | null {
    assertSafeRunId(runId)
    this.pendingReplay.add(runId)
    const base = this.readSnapshot(runId)
    if (!base) {
      this.pendingReplay.delete(runId)
      return null
    }
    const { events, truncatedByCorruption } = this.loadEvents(runId)
    if (truncatedByCorruption) {
      console.warn(`[RunStore] runId=${runId} 事件流中间损坏，仅重放到损坏点前`)
    }
    let snap = { ...base }
    for (const ev of events) {
      if (ev.sequence <= base.sequence) continue
      // 重放时只推进 sequence / updatedAt；具体字段由事件类型可选合并
      snap = {
        ...snap,
        sequence: ev.sequence,
        updatedAt: ev.at,
        ...(typeof ev.payload === 'object' && ev.payload ? reduceEventPayload(snap, ev) : {})
      }
    }
    // 若事件领先 snapshot，把重放结果写回，使磁盘一致
    if (snap.sequence > base.sequence) {
      atomicWriteFileSync(this.snapshotPath(runId), JSON.stringify(snap, null, 2))
    }
    this.pendingReplay.delete(runId)
    return snap
  }

  /** 列出磁盘上所有 runId（过滤非法名） */
  listRunIds(): string[] {
    if (!fs.existsSync(this.runsRoot)) return []
    try {
      return fs
        .readdirSync(this.runsRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .filter(id => {
          try {
            assertSafeRunId(id)
            return true
          } catch {
            return false
          }
        })
    } catch {
      return []
    }
  }

  /**
   * 扫描未终态 run（启动对账）；已终态只读 snapshot，不重放 events。
   * 全盘扫描对单条腐坏记录隔离跳过，不让一条坏记录瘫痪启动对账。
   */
  listNonTerminalSnapshots(): RunSnapshot[] {
    const result: RunSnapshot[] = []
    for (const runId of this.listRunIds()) {
      try {
        const peek = this.loadSnapshot(runId)
        if (!peek || isTerminalRunStatus(peek.status)) continue
        const snap = this.loadSnapshotWithReplay(runId)
        if (snap && !isTerminalRunStatus(snap.status)) {
          result.push(snap)
        }
      } catch (err) {
        console.error(`[RunStore] 跳过腐坏 run 记录 runId=${runId}:`, err)
      }
    }
    return result
  }

  /** 按 sessionId 查找最新非终态或最近 snapshot */
  findSnapshotsBySession(sessionId: string): RunSnapshot[] {
    return this.findSnapshotsBySessions(new Set([sessionId]))
  }

  /**
   * 一次目录扫描；先看 snapshot 的 sessionId 与状态。
   * 普通终态记录不读事件日志；带 dispatch/deliveryBinding 的新协议终态记录
   * 走尾部事件收敛（投递事件可能领先快照）。腐坏记录隔离跳过。
   */
  findSnapshotsBySessions(sessionIds: ReadonlySet<string>): RunSnapshot[] {
    if (sessionIds.size === 0) return []
    const result: RunSnapshot[] = []
    for (const runId of this.listRunIds()) {
      try {
        const peek = this.loadSnapshot(runId)
        if (!peek || !sessionIds.has(peek.sessionId)) continue
        const snap = isTerminalRunStatus(peek.status)
          ? peek.dispatch || peek.deliveryBinding
            ? this.loadSnapshotWithReplay(runId)
            : peek
          : this.loadSnapshotWithReplay(runId)
        if (snap) result.push(snap)
      } catch (err) {
        console.error(`[RunStore] 跳过腐坏 run 记录 runId=${runId}:`, err)
      }
    }
    result.sort((a, b) => b.updatedAt - a.updatedAt)
    return result
  }

  /**
   * 启动恢复入口：只对带新协议记录（dispatch/deliveryBinding）的终态 run 收敛尾部事件。
   * 普通历史终态记录不读事件日志。返回尾部确实领先快照并已写回的快照。
   */
  recoverTerminalProtocolTails(): RunSnapshot[] {
    const result: RunSnapshot[] = []
    for (const runId of this.listRunIds()) {
      try {
        const peek = this.loadSnapshot(runId)
        if (!peek || !isTerminalRunStatus(peek.status)) continue
        if (!peek.dispatch && !peek.deliveryBinding) continue
        const replayed = this.loadSnapshotWithReplay(runId)
        if (replayed && replayed.sequence > peek.sequence) {
          result.push(replayed)
        }
      } catch (err) {
        console.error(`[RunStore] 跳过腐坏 run 记录 runId=${runId}:`, err)
      }
    }
    return result
  }

  /** 删除 run 目录（可选清理） */
  deleteRun(runId: string): void {
    const dir = this.runDir(runId)
    if (!fs.existsSync(dir)) return
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      console.error(`[RunStore] 删除 run 失败 runId=${runId}:`, err)
    }
  }
}

/** 将可安全合并的事件 payload 叠到 snapshot（保守：只处理已知键） */
function reduceEventPayload(
  snap: RunSnapshot,
  ev: RunEventRecord
): Partial<RunSnapshot> {
  const p = ev.payload ?? {}
  switch (ev.type) {
    case 'terminal':
      return {
        status: (typeof p.status === 'string' ? p.status : snap.status) as RunSnapshot['status'],
        terminalReason: typeof p.reason === 'string' ? p.reason : snap.terminalReason,
        terminalTransitionId:
          typeof p.terminalTransitionId === 'string'
            ? p.terminalTransitionId
            : snap.terminalTransitionId,
        incompleteReason: isTurnTruncationReason(p.incompleteReason)
          ? p.incompleteReason
          : snap.incompleteReason
      }
    case 'execution_generation':
      return {
        executionGeneration:
          typeof p.executionGeneration === 'number'
            ? p.executionGeneration
            : snap.executionGeneration
      }
    case 'turn_draft_cleared':
      return { turnDraft: null }
    case 'delivery_binding': {
      // 未知版本失败关闭：解码错误向上抛，重放中止且不写回快照。
      // 捕获后忽略仍推进 sequence 会永久掩埋该控制事实，下次启动也不会再尝试。
      // 调用方按单条 run 隔离腐坏记录，事件保留在日志中待新版本读取。
      const binding = decodeSubagentDeliveryBinding(p.binding)
      return binding ? { deliveryBinding: binding } : {}
    }
    case 'reconcile_interrupted':
      return {
        status: 'interrupted',
        terminalReason: typeof p.reason === 'string' ? p.reason : 'process_exit'
      }
    default:
      return {}
  }
}
