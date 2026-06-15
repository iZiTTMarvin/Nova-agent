/**
 * WorkspaceService — 应用级"当前状态"单一事实源
 *
 * 与 PRD §5.1 对齐。主进程持有唯一的 WorkspaceState（当前会话 ID、项目路径、模式），
 * 所有会话/项目/模式/回滚操作都由本服务统一处理，完成后通过广播通知 renderer。
 *
 * 设计原则：
 * - 主进程是唯一写入方：selectProject / createSession / deleteSession / selectSession /
 *   setMode / rollbackMessage 全部在这里完成状态转换 + 副作用，再广播。
 * - renderer 只订阅 workspace:changed，不反向写其它 store。
 * - 会话列表（availableSessions）随状态一起广播，避免 renderer 二次拉取。
 */
import { dialog, BrowserWindow } from 'electron'
import type { SessionStore } from '../../runtime/sessions/SessionStore'
import type { SessionData } from '../../runtime/sessions/types'
import type { Mode, Session, SessionDetail } from '../../shared/session'
import type { WorkspaceState } from '../../shared/workspace/types'
import { revertToMessage, listManifests } from '../../runtime/checkpoints/restore'
import { DiffReviewService } from '../../runtime/checkpoints/DiffReviewService'
import { getMainReadState } from '../ipc/agentHandler'
import { setCurrentProjectPath, setCurrentMode } from '../index'
import { reloadSkillsForWorkspace } from './SkillServiceHost'

/** SessionDetail 转换（与 sessionHandler 同构，独立实现避免双向依赖） */
function toSession(data: SessionData): Session {
  return {
    id: data.id,
    workspaceRoot: data.workspaceRoot,
    mode: data.mode,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    messageCount: data.messages.length
  }
}

export interface WorkspaceServiceDeps {
  /** 获取 SessionStore 单例 */
  getSessionStore: () => SessionStore
  /** 获取主窗口（用于文件夹选择对话框） */
  getMainWindow: () => BrowserWindow | null
}

export class WorkspaceService {
  private state: WorkspaceState = {
    currentSessionId: null,
    currentProjectPath: null,
    currentMode: 'default',
    availableSessions: []
  }

  /** 广播回调：由 workspaceHandler 注入，负责把状态推给 renderer */
  private broadcaster: ((state: WorkspaceState) => void) | null = null

  constructor(private readonly deps: WorkspaceServiceDeps) {}

  /** 注入广播函数（handler 层负责实际 webContents.send） */
  setBroadcaster(fn: (state: WorkspaceState) => void): void {
    this.broadcaster = fn
  }

  /** 读取当前状态（不广播） */
  getState(): WorkspaceState {
    return this.state
  }

  /**
   * 启动时初始化：从 SessionStore 加载会话列表，选中最近一条会话（若有）。
   * 在 registerIpcHandlers 之后、createMainWindow 之前调用。
   */
  initOnStartup(): void {
    const store = this.deps.getSessionStore()
    const sessions = store.list()
    this.state = {
      currentSessionId: null,
      currentProjectPath: null,
      currentMode: 'default',
      availableSessions: sessions
    }
  }

  /**
   * 选择项目工作区。
   * - params.path 非空：直接使用该路径。
   * - params 为空：弹出文件夹选择对话框。
   * 选择成功后自动创建新会话。
   */
  async selectProject(params?: { path?: string }): Promise<WorkspaceState> {
    const store = this.deps.getSessionStore()
    let selectedPath = params?.path ?? null

    if (!selectedPath) {
      const window = this.deps.getMainWindow()
      if (!window) return this.state
      const result = await dialog.showOpenDialog(window, {
        title: '选择本地项目工作区',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return this.state
      }
      selectedPath = result.filePaths[0]
    }

    // 同步主进程全局路径（供 AgentLoop 等模块使用 workingDir 边界）
    setCurrentProjectPath(selectedPath)
    reloadSkillsForWorkspace(selectedPath)

    // 创建新会话
    const data = store.create(selectedPath, this.state.currentMode)
    getMainReadState().clear()

    this.state = {
      currentSessionId: data.id,
      currentProjectPath: selectedPath,
      currentMode: data.mode,
      availableSessions: store.list()
    }
    this.broadcast()
    return this.state
  }

  /** 显式创建新会话（使用给定 workspaceRoot，或沿用当前项目） */
  createSession(params: { workspaceRoot: string; mode?: Mode }): WorkspaceState {
    const store = this.deps.getSessionStore()
    const data = store.create(params.workspaceRoot, params.mode ?? this.state.currentMode)
    getMainReadState().clear()
    setCurrentProjectPath(params.workspaceRoot)
    setCurrentMode(data.mode)

    this.state = {
      currentSessionId: data.id,
      currentProjectPath: params.workspaceRoot,
      currentMode: data.mode,
      availableSessions: store.list()
    }
    this.broadcast()
    return this.state
  }

  /**
   * 删除会话。
   * 删除的是当前会话时，自动切到剩余列表的第一条；没有剩余会话则清空工作区。
   */
  deleteSession(sessionId: string): WorkspaceState {
    const store = this.deps.getSessionStore()
    store.delete(sessionId)

    const remaining = store.list()
    const deletingCurrent = this.state.currentSessionId === sessionId

    if (deletingCurrent) {
      if (remaining.length > 0) {
        // 切到剩余的第一条（递归复用 selectSession 逻辑，但避免广播两次）
        const next = remaining[0]
        const detail = store.load(next.id)
        if (detail) {
          getMainReadState().clear()
          setCurrentProjectPath(detail.workspaceRoot)
          setCurrentMode(detail.mode)
          this.state = {
            currentSessionId: detail.id,
            currentProjectPath: detail.workspaceRoot,
            currentMode: detail.mode,
            availableSessions: remaining
          }
        } else {
          this.state = { ...this.state, availableSessions: remaining }
        }
      } else {
        getMainReadState().clear()
        setCurrentProjectPath(null)
        this.state = {
          currentSessionId: null,
          currentProjectPath: null,
          currentMode: 'default',
          availableSessions: []
        }
      }
    } else {
      this.state = { ...this.state, availableSessions: remaining }
    }

    this.broadcast()
    return this.state
  }

  /** 切换当前会话（并同步主进程项目路径/模式） */
  selectSession(sessionId: string): WorkspaceState {
    const store = this.deps.getSessionStore()
    const detail = store.load(sessionId)
    if (!detail) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }

    getMainReadState().clear()
    setCurrentProjectPath(detail.workspaceRoot)
    setCurrentMode(detail.mode)

    this.state = {
      currentSessionId: detail.id,
      currentProjectPath: detail.workspaceRoot,
      currentMode: detail.mode,
      availableSessions: store.list()
    }
    this.broadcast()
    return this.state
  }

  /** 切换运行模式（并持久化到当前会话） */
  setMode(params: { mode: Mode; sessionId?: string }): WorkspaceState {
    const store = this.deps.getSessionStore()
    const sessionId = params.sessionId ?? this.state.currentSessionId

    if (sessionId) {
      store.updateMode(sessionId, params.mode)
      // 同步 availableSessions 里的 mode 字段
      this.state.availableSessions = store.list()
    }

    setCurrentMode(params.mode)
    this.state = { ...this.state, currentMode: params.mode }
    this.broadcast()
    return this.state
  }

  /**
   * 回滚到某条消息之前。
   * 物理回退（恢复文件 + 删除 checkpoint）+ 会话数据裁剪 + readState 清空，
   * 完成后刷新 availableSessions（updatedAt 变化）。
   */
  rollbackMessage(params: { sessionId: string; messageId: string }): WorkspaceState {
    const store = this.deps.getSessionStore()
    const { sessionId, messageId } = params
    const session = store.load(sessionId)
    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }

    const checkpointRoot = store.getSessionsDir()
    const allManifests = listManifests(checkpointRoot, sessionId)
    const success = revertToMessage(
      checkpointRoot,
      session.workspaceRoot,
      sessionId,
      messageId,
      allManifests
    )
    if (!success) {
      throw new Error('回退失败：找不到目标消息对应的 checkpoint')
    }

    const targetIdx = session.messages.findIndex(m => m.id === messageId)
    if (targetIdx !== -1) {
      session.messages = session.messages.slice(0, targetIdx)
      session.updatedAt = Date.now()
      store.save(session)
    }
    getMainReadState().clear()

    this.state = {
      ...this.state,
      availableSessions: store.list()
    }
    this.broadcast()
    return this.state
  }

  // ── Diff 审阅操作委托给 DiffReviewService（PRD §5.3） ──
  // 拆出原因：单一事实源不等于万能服务。diff 审阅属于 checkpoint 领域，
  // 归 DiffReviewService 处理；WorkspaceService 只负责工作区状态广播。

  /** 接受单个文件改动 */
  acceptFile(sessionId: string, messageId: string, filePath: string): void {
    this.getDiffReviewService().acceptFile(sessionId, messageId, filePath)
  }

  /** 拒绝单个文件改动（从 checkpoint 恢复） */
  rejectFile(sessionId: string, messageId: string, filePath: string): void {
    this.getDiffReviewService().rejectFile(sessionId, messageId, filePath)
  }

  /** 批量接受多个文件（Phase E） */
  acceptAllFiles(sessionId: string, messageId: string, filePaths: string[]): void {
    this.getDiffReviewService().acceptAllFiles(sessionId, messageId, filePaths)
  }

  /**
   * 批量拒绝多个文件（Phase E，PRD §5.3.3 事务性）。
   * 委托给 DiffReviewService，逐个恢复，任一失败则回滚已恢复文件（保持原子性）。
   */
  rejectAllFiles(
    sessionId: string,
    messageId: string,
    filePaths: string[]
  ): { restored: string[]; failed: Array<{ filePath: string; error: string }> } {
    return this.getDiffReviewService().rejectAllFiles(sessionId, messageId, filePaths)
  }

  /** 懒加载 DiffReviewService（首次访问时用 SessionStore 构造） */
  private getDiffReviewService(): DiffReviewService {
    if (!this.diffReviewService) {
      this.diffReviewService = new DiffReviewService(this.deps.getSessionStore())
    }
    return this.diffReviewService
  }
  private diffReviewService: DiffReviewService | null = null

  /** 广播当前状态给 renderer */
  private broadcast(): void {
    this.broadcaster?.(this.state)
  }
}

/** 单例 */
let workspaceService: WorkspaceService | null = null

export function initWorkspaceService(deps: WorkspaceServiceDeps): WorkspaceService {
  workspaceService = new WorkspaceService(deps)
  return workspaceService
}

export function getWorkspaceService(): WorkspaceService {
  if (!workspaceService) {
    throw new Error('WorkspaceService 尚未初始化，请先调用 initWorkspaceService')
  }
  return workspaceService
}
