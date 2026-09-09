/**
 * 主进程 RunCoordinator 单例宿主
 *
 * 与 Electron app 路径绑定；runtime 层本身不依赖 Electron。
 */
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import {
  createRunCoordinator,
  RunExecutionRegistry,
  type RunCoordinator
} from '../../runtime/run'
import type { RunEventRecord, RunSnapshot } from '../../shared/run/types'
import { toRendererRunSnapshot } from '../../shared/run/rendererProjection'
import { SnapshotBroadcastCoalescer } from './runSnapshotBroadcast'

let coordinator: RunCoordinator | null = null
let executionRegistry: RunExecutionRegistry | null = null
let getMainWindowRef: (() => BrowserWindow | null) | null = null
const destroyGuardedContents = new WeakSet<BrowserWindow['webContents']>()

const snapshotBroadcast = new SnapshotBroadcastCoalescer((snapshot, event) => {
  const win = getMainWindowRef?.()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    snapshotBroadcast.cancel()
    return
  }
  win.webContents.send('run:snapshot', {
    snapshot: toRendererRunSnapshot(snapshot),
    event: {
      sequence: event.sequence,
      type: event.type,
      at: event.at
    }
  })
})

/** 当前 SEND_MESSAGE 绑定的 runId（兼容旧 agentTurnInProgress） */
let activeRunId: string | null = null

export function getActiveRunId(): string | null {
  return activeRunId
}

export function setActiveRunId(runId: string | null): void {
  activeRunId = runId
}

function guardWindowLifetime(win: BrowserWindow): void {
  const contents = win.webContents
  if (destroyGuardedContents.has(contents)) return
  destroyGuardedContents.add(contents)
  contents.once('destroyed', () => {
    snapshotBroadcast.cancel()
  })
  win.once('closed', () => {
    snapshotBroadcast.cancel()
  })
}

function broadcastSnapshot(snapshot: RunSnapshot, event: RunEventRecord): void {
  const win = getMainWindowRef?.()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    snapshotBroadcast.cancel()
    return
  }
  guardWindowLifetime(win)
  snapshotBroadcast.push(snapshot, event)
}

/**
 * 初始化（应在 registerIpcHandlers / registerAgentHandler 时调用一次）。
 * 启动时扫描未终态 run → interrupted。
 */
export function initRunCoordinatorHost(
  getMainWindow: () => BrowserWindow | null
): { coordinator: RunCoordinator; interrupted: RunSnapshot[] } {
  getMainWindowRef = getMainWindow
  let interrupted: RunSnapshot[] = []
  if (!coordinator) {
    const runsRoot = join(app.getPath('userData'), 'runs')
    coordinator = createRunCoordinator(runsRoot, broadcastSnapshot)
    interrupted = coordinator.reconcileOnStartup()
    if (interrupted.length > 0) {
      console.info(
        `[RunCoordinator] 启动对账：${interrupted.length} 个未终态 run 已标记为 interrupted`
      )
    }
  }
  return { coordinator, interrupted }
}

export function getRunCoordinator(): RunCoordinator {
  if (!coordinator) {
    throw new Error('RunCoordinator 尚未初始化，请先调用 initRunCoordinatorHost')
  }
  return coordinator
}

/** 进程内执行句柄单例：连接 IPC 取消命令与真实执行。 */
export function getRunExecutionRegistry(): RunExecutionRegistry {
  if (!executionRegistry) {
    executionRegistry = new RunExecutionRegistry()
  }
  return executionRegistry
}

/** 测试用：重置单例 */
export function resetRunCoordinatorHostForTests(): void {
  snapshotBroadcast.cancel()
  coordinator = null
  executionRegistry = null
  activeRunId = null
  getMainWindowRef = null
}
