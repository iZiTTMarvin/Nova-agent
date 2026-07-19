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
import { XForgeRunService } from '../../runtime/workflow/xforge/XForgeRunService'

let coordinator: RunCoordinator | null = null
let xforgeRunService: XForgeRunService | null = null
let executionRegistry: RunExecutionRegistry | null = null
let getMainWindowRef: (() => BrowserWindow | null) | null = null

/** 当前 SEND_MESSAGE 绑定的 runId（兼容旧 agentTurnInProgress） */
let activeRunId: string | null = null

export function getActiveRunId(): string | null {
  return activeRunId
}

export function setActiveRunId(runId: string | null): void {
  activeRunId = runId
}

function broadcastSnapshot(snapshot: RunSnapshot, event: RunEventRecord): void {
  const win = getMainWindowRef?.()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('run:snapshot', {
    snapshot,
    event: {
      sequence: event.sequence,
      type: event.type,
      at: event.at
    }
  })
}

/**
 * 初始化（应在 registerIpcHandlers / registerAgentHandler 时调用一次）。
 * 启动时扫描未终态 run → interrupted。
 */
export function initRunCoordinatorHost(
  getMainWindow: () => BrowserWindow | null
): RunCoordinator {
  getMainWindowRef = getMainWindow
  if (!coordinator) {
    const runsRoot = join(app.getPath('userData'), 'runs')
    coordinator = createRunCoordinator(runsRoot, broadcastSnapshot)
    xforgeRunService = new XForgeRunService(coordinator)
    const interrupted = coordinator.reconcileOnStartup()
    if (interrupted.length > 0) {
      console.info(
        `[RunCoordinator] 启动对账：${interrupted.length} 个未终态 run 已标记为 interrupted`
      )
    }
  }
  return coordinator
}

export function getRunCoordinator(): RunCoordinator {
  if (!coordinator) {
    throw new Error('RunCoordinator 尚未初始化，请先调用 initRunCoordinatorHost')
  }
  return coordinator
}

export function getXForgeRunService(): XForgeRunService {
  if (!xforgeRunService) {
    xforgeRunService = new XForgeRunService(getRunCoordinator())
  }
  return xforgeRunService
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
  coordinator = null
  xforgeRunService = null
  executionRegistry = null
  activeRunId = null
  getMainWindowRef = null
}
