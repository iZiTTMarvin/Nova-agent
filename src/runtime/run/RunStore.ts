/**
 * RunStore — 原子 snapshot + append-only events
 *
 * 唯一落盘协议（所有状态变化必须走 commitTransaction）：
 *   next sequence → append event → fsync event → reduce snapshot → atomic replace snapshot
 *
 * 启动恢复：读取 snapshot.sequence，重放 events 中更大的合法事件。
 * 损坏末行可忽略；中间损坏不得跳过后续假装一致。
 */
import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteFileSync } from '../storage/atomicFile'
import {
  isTerminalRunStatus,
  type RunEventRecord,
  type RunSnapshot
} from './types'

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
   * 唯一持久化提交入口。
   * 调用方传入「已 reduce 的下一快照」与事件类型；本方法分配 sequence 并按协议落盘。
   */
  commitTransaction(
    nextSnapshot: RunSnapshot,
    eventType: string,
    payload?: Record<string, unknown>
  ): RunEventRecord {
    assertSafeRunId(nextSnapshot.runId)
    const dir = this.runDir(nextSnapshot.runId)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const sequence = nextSnapshot.sequence
    const event: RunEventRecord = {
      sequence,
      runId: nextSnapshot.runId,
      type: eventType,
      at: Date.now(),
      payload
    }

    // 1) append event + fsync
    this.appendEventFsynced(event)
    // 2) atomic replace snapshot（含已递增的 sequence）
    atomicWriteFileSync(this.snapshotPath(nextSnapshot.runId), JSON.stringify(nextSnapshot, null, 2))
    return event
  }

  /** 追加事件并 fsync，确保崩溃前事件已落盘 */
  private appendEventFsynced(event: RunEventRecord): void {
    const filePath = this.eventsPath(event.runId)
    const line = JSON.stringify(event) + '\n'
    const fd = fs.openSync(filePath, 'a')
    try {
      fs.writeSync(fd, line, null, 'utf8')
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

  /** 读取 snapshot；不存在返回 null */
  loadSnapshot(runId: string): RunSnapshot | null {
    assertSafeRunId(runId)
    const filePath = this.snapshotPath(runId)
    if (!fs.existsSync(filePath)) return null
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      return JSON.parse(raw) as RunSnapshot
    } catch (err) {
      console.error(`[RunStore] 读取 snapshot 失败 runId=${runId}:`, err)
      return null
    }
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
    const base = this.loadSnapshot(runId)
    if (!base) return null
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

  /** 扫描未终态 run（启动对账）；先做事件尾部重放 */
  listNonTerminalSnapshots(): RunSnapshot[] {
    const result: RunSnapshot[] = []
    for (const runId of this.listRunIds()) {
      const snap = this.loadSnapshotWithReplay(runId)
      if (snap && !isTerminalRunStatus(snap.status)) {
        result.push(snap)
      }
    }
    return result
  }

  /** 按 sessionId 查找最新非终态或最近 snapshot */
  findSnapshotsBySession(sessionId: string): RunSnapshot[] {
    const result: RunSnapshot[] = []
    for (const runId of this.listRunIds()) {
      const snap = this.loadSnapshotWithReplay(runId)
      if (snap && snap.sessionId === sessionId) {
        result.push(snap)
      }
    }
    result.sort((a, b) => b.updatedAt - a.updatedAt)
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
            : snap.terminalTransitionId
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
    case 'reconcile_interrupted':
      return {
        status: 'interrupted',
        terminalReason: typeof p.reason === 'string' ? p.reason : 'process_exit'
      }
    default:
      return {}
  }
}
