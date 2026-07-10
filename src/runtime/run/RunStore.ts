/**
 * RunStore — 原子 snapshot + append-only events
 *
 * 落盘布局（每 run）：
 *   <runsRoot>/<runId>/snapshot.json
 *   <runsRoot>/<runId>/events.jsonl
 *
 * snapshot 用 atomicWriteFileSync；events 追加写。
 * 主进程崩溃后可扫描未终态 run 做对账。
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
    return path.join(this.runsRoot, runId)
  }

  private snapshotPath(runId: string): string {
    return path.join(this.runDir(runId), 'snapshot.json')
  }

  private eventsPath(runId: string): string {
    return path.join(this.runDir(runId), 'events.jsonl')
  }

  /** 原子写入完整 snapshot */
  saveSnapshot(snapshot: RunSnapshot): void {
    const dir = this.runDir(snapshot.runId)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    atomicWriteFileSync(this.snapshotPath(snapshot.runId), JSON.stringify(snapshot, null, 2))
  }

  /** 读取 snapshot；不存在返回 null */
  loadSnapshot(runId: string): RunSnapshot | null {
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

  /** 追加一条事件（append-only） */
  appendEvent(event: RunEventRecord): void {
    const dir = this.runDir(event.runId)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const line = JSON.stringify(event) + '\n'
    fs.appendFileSync(this.eventsPath(event.runId), line, 'utf8')
  }

  /** 读取全部事件（诊断 / 恢复用）；末行损坏可跳过 */
  loadEvents(runId: string): RunEventRecord[] {
    const filePath = this.eventsPath(runId)
    if (!fs.existsSync(filePath)) return []
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      const lines = raw.split('\n').filter(l => l.trim().length > 0)
      const events: RunEventRecord[] = []
      for (const line of lines) {
        try {
          events.push(JSON.parse(line) as RunEventRecord)
        } catch {
          // 最后一条损坏可跳过
        }
      }
      return events
    } catch (err) {
      console.error(`[RunStore] 读取 events 失败 runId=${runId}:`, err)
      return []
    }
  }

  /** 列出磁盘上所有 runId */
  listRunIds(): string[] {
    if (!fs.existsSync(this.runsRoot)) return []
    try {
      return fs
        .readdirSync(this.runsRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
    } catch {
      return []
    }
  }

  /** 扫描未终态 run（启动对账） */
  listNonTerminalSnapshots(): RunSnapshot[] {
    const result: RunSnapshot[] = []
    for (const runId of this.listRunIds()) {
      const snap = this.loadSnapshot(runId)
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
      const snap = this.loadSnapshot(runId)
      if (snap && snap.sessionId === sessionId) {
        result.push(snap)
      }
    }
    // 新的在前
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
