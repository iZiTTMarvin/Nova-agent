import { stat } from 'node:fs/promises'
import type { CodeIndexStatusDto } from '../../shared/code-index'
import type { CodeIndexSnapshot } from '../../runtime/code-graph'

export const CODE_INDEX_STATUS_THROTTLE_MS = 500

export type CodeGraphStatusBroadcaster = (snapshot: CodeIndexStatusDto) => void

interface ProjectionState {
  sequence: number
  version: number
  latestSnapshot: CodeIndexSnapshot | null
  databasePath: string | null
  timer: ReturnType<typeof setTimeout> | null
}

export interface CodeGraphStatusProjectionOptions {
  readonly throttleMs?: number
  readonly readDatabaseBytes?: (databasePath: string) => Promise<number>
}

/** 将 Coordinator 快照投影为节流 IPC；不拥有或改写索引领域状态。 */
export class CodeGraphStatusProjection {
  private readonly states = new Map<string, ProjectionState>()
  private readonly throttleMs: number
  private readonly readDatabaseBytes: (databasePath: string) => Promise<number>
  private broadcaster: CodeGraphStatusBroadcaster | null = null

  constructor(options: CodeGraphStatusProjectionOptions = {}) {
    this.throttleMs = Math.max(
      CODE_INDEX_STATUS_THROTTLE_MS,
      options.throttleMs ?? CODE_INDEX_STATUS_THROTTLE_MS
    )
    this.readDatabaseBytes = options.readDatabaseBytes ?? readDatabaseSize
  }

  setBroadcaster(broadcaster: CodeGraphStatusBroadcaster | null): void {
    this.broadcaster = broadcaster
  }

  observe(
    workspaceRoot: string,
    snapshot: CodeIndexSnapshot,
    databasePath: string
  ): void {
    const state = this.getState(workspaceRoot)
    state.version += 1
    state.latestSnapshot = snapshot
    state.databasePath = databasePath
    if (state.timer !== null) return
    // 固定窗口只发送窗口末尾快照，短暂 updating → ready 不会在界面闪烁。
    state.timer = setTimeout(() => {
      state.timer = null
      void this.flush(workspaceRoot, state)
    }, this.throttleMs)
  }

  async getEnabledStatus(
    workspaceRoot: string,
    snapshot: CodeIndexSnapshot,
    databasePath: string
  ): Promise<CodeIndexStatusDto> {
    const state = this.getState(workspaceRoot)
    if (state.latestSnapshot !== snapshot || state.databasePath !== databasePath) {
      state.version += 1
    }
    state.latestSnapshot = snapshot
    state.databasePath = databasePath
    const version = state.version
    const databaseBytes = await this.safeReadDatabaseBytes(databasePath)
    const currentSnapshot = state.version === version
      ? snapshot
      : state.latestSnapshot ?? snapshot
    return this.project(workspaceRoot, state, true, currentSnapshot, databaseBytes)
  }

  getDisabledStatus(workspaceRoot: string | null): CodeIndexStatusDto {
    const state = this.getState(workspaceRoot)
    return this.project(workspaceRoot, state, false, null, 0)
  }

  suspend(workspaceRoot: string): void {
    const state = this.states.get(workspaceRoot)
    if (!state) return
    if (state.timer !== null) clearTimeout(state.timer)
    state.version += 1
    state.timer = null
    state.latestSnapshot = null
    state.databasePath = null
  }

  reset(): void {
    for (const state of this.states.values()) {
      if (state.timer !== null) clearTimeout(state.timer)
    }
    this.states.clear()
    this.broadcaster = null
  }

  private async flush(workspaceRoot: string, state: ProjectionState): Promise<void> {
    const snapshot = state.latestSnapshot
    const databasePath = state.databasePath
    const version = state.version
    if (snapshot === null || databasePath === null) return
    const databaseBytes = await this.safeReadDatabaseBytes(databasePath)
    if (state.version !== version || state.latestSnapshot !== snapshot) return
    const projected = this.project(workspaceRoot, state, true, snapshot, databaseBytes)
    this.broadcaster?.(projected)
  }

  private project(
    workspaceRoot: string | null,
    state: ProjectionState,
    enabled: boolean,
    snapshot: CodeIndexSnapshot | null,
    databaseBytes: number
  ): CodeIndexStatusDto {
    state.sequence += 1
    const coverage = snapshot?.coverage ?? {
      eligibleFiles: 0,
      indexedFiles: 0,
      parseFailures: 0,
      unsupportedFiles: 0,
      oversizedFiles: 0,
      unresolvedRelations: 0
    }
    return Object.freeze({
      workspaceRoot,
      sequence: state.sequence,
      enabled,
      status: snapshot?.status ?? 'idle',
      activeGeneration: snapshot?.activeGeneration ?? null,
      revision: snapshot?.revision ?? 0,
      coverage: Object.freeze({ ...coverage }),
      progress: snapshot?.progress === null || snapshot?.progress === undefined
        ? null
        : Object.freeze({ ...snapshot.progress }),
      lastCompletedAt: snapshot?.lastCompletedAt ?? null,
      failure: snapshot?.failure === null || snapshot?.failure === undefined
        ? null
        : Object.freeze({ ...snapshot.failure }),
      workerState: snapshot?.workerState ?? 'stopped',
      databaseBytes: Math.max(0, databaseBytes)
    })
  }

  private getState(workspaceRoot: string | null): ProjectionState {
    const key = workspaceRoot ?? '\0'
    let state = this.states.get(key)
    if (!state) {
      state = {
        sequence: 0,
        version: 0,
        latestSnapshot: null,
        databasePath: null,
        timer: null
      }
      this.states.set(key, state)
    }
    return state
  }

  private async safeReadDatabaseBytes(databasePath: string): Promise<number> {
    try {
      return await this.readDatabaseBytes(databasePath)
    } catch {
      return 0
    }
  }
}

async function readDatabaseSize(databasePath: string): Promise<number> {
  const sizes = await Promise.all(
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(async path => {
      try {
        return (await stat(path)).size
      } catch {
        return 0
      }
    })
  )
  return sizes.reduce((total, size) => total + size, 0)
}
