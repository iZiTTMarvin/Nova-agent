/**
 * WorkspaceService — 应用级"当前状态"单一事实源
 *
 * 与 PRD §5.1 对齐。主进程持有唯一的 WorkspaceState（当前会话 ID、项目路径、模式），
 * 所有会话/项目/模式/回滚操作都由本服务统一处理，完成后通过广播通知 renderer。
 *
 * 设计原则：
 * - 主进程是唯一写入方：selectProject / createSession / deleteSession / selectSession /
 *   setMode / prepareEditResend / prepareRegenerate / switchBranch 全部在这里完成状态转换 + 副作用，再广播。
 * - renderer 只订阅 workspace:changed，不反向写其它 store。
 * - 会话列表（availableSessions）随状态一起广播，避免 renderer 二次拉取。
 */
import { dialog, BrowserWindow, app } from 'electron'
import type { SessionStore } from '../../runtime/sessions/SessionStore'
import type { SessionData } from '../../runtime/sessions/types'
import { clampSessionTitle } from '../../shared/session/title'
import { getSessionActiveMessages, buildChildrenIndex, ensureMessageParentChain, findCommonAncestor, findSubtreeLeaf, resolveCurrentLeafId, computeActivePath, getBranchPosition } from '../../runtime/sessions/tree'
import type { Mode, Session, SessionDetail } from '../../shared/session'
import type { WorkspaceState, Tier1BranchContext } from '../../shared/workspace/types'
import { revertWorkspaceForMessageIds, applyForwardForMessageIds, listManifests } from '../../runtime/checkpoints/restore'
import { DiffReviewService } from '../../runtime/checkpoints/DiffReviewService'
import { getMainReadState, isAgentTurnInProgress, getActiveTurnSessionId } from '../ipc/agentHandler'
import { setCurrentProjectPath, setCurrentMode } from '../index'
import { reloadSkillsForWorkspace, getSkillService } from './SkillServiceHost'
import { calculateContextBreakdown } from '../../runtime/agent'
import { loadModelConfig } from '../../runtime/model/config'
import { inferContextWindow } from '../../shared/config/types'
/** SessionDetail 转换（与 sessionHandler 同构，独立实现避免双向依赖） */
function toSession(data: SessionData): Session {
  const activeMessages = getSessionActiveMessages(data)
  return {
    id: data.id,
    workspaceRoot: data.workspaceRoot,
    mode: data.mode,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    messageCount: activeMessages.length,
    title: data.title
  }
}
/** 计算并直接推送某会话的上下文容量拆分给 renderer */
function pushContextBreakdownForSession(session: SessionData, getMainWindow: () => BrowserWindow | null): void {
  const skillService = getSkillService()
  if (skillService.getWorkspaceRoot() !== session.workspaceRoot) {
    skillService.load(session.workspaceRoot)
  }
  const skills = skillService.getRegistry().listForContext()

  const persistedConfig = loadModelConfig(app.getPath('userData'))
  const contextLimit = persistedConfig?.contextWindow ?? inferContextWindow(persistedConfig?.modelId ?? '')

  const { payload } = calculateContextBreakdown({
    session,
    skills,
    toolDefinitions: [],
    contextLimit
  })

  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:context-breakdown', payload)
  }
}

export interface WorkspaceServiceDeps {
  /** 获取 SessionStore 单例 */
  getSessionStore: () => SessionStore
  /** 获取主窗口（用于文件夹选择对话框） */
  getMainWindow: () => BrowserWindow | null
  /** 工作区根路径变更时回调（如触发记忆索引 reconcile，勿阻塞） */
  onWorkspaceRootChanged?: (workspaceRoot: string | null) => void
  /**
   * 离开会话前回调（切走/删除/新建前）：主进程 sync drain + fire-and-forget 落盘。
   * 须在 SessionStore 删除会话之前调用，以便拿到 workspaceRoot。
   */
  onSessionLeaving?: (sessionId: string, workspaceRoot: string) => void
  /** 会话采集收尾：清 pending/buffer 注册表 */
  onSessionCaptureCleanup?: (sessionId: string) => void
}

export class WorkspaceService {
  /**
   * 内部状态不含 messagesRevision：revision 由独立计数器维护，
   * 在 getState() / broadcast() 出口统一盖章，避免每处状态字面量都漏写。
   */
  private state: Omit<WorkspaceState, 'messagesRevision' | 'tier1BranchContext'> = {
    currentSessionId: null,
    currentProjectPath: null,
    currentMode: 'default',
    availableSessions: []
  }

  /**
   * 「同会话内消息序列变化」的版本号。切分支、分叉完成后补同步、desync 纠正等 +1，
   * renderer 据此绕过 sessionChanged 守卫重拉消息（含 branch 元信息）。
   */
  private messagesRevision = 0

  /** Tier 1 切分支提示上下文；随 workspace:changed 下发给 renderer */
  private tier1BranchContext: Tier1BranchContext | null = null

  /** 广播回调：由 workspaceHandler 注入，负责把状态推给 renderer */
  private broadcaster: ((state: WorkspaceState) => void) | null = null

  constructor(private readonly deps: WorkspaceServiceDeps) {}

  /** 工作区根路径变更时触发外部回调（记忆 reconcile 等后台任务） */
  private notifyWorkspaceRootChanged(workspaceRoot: string | null): void {
    this.deps.onWorkspaceRootChanged?.(workspaceRoot)
  }

  /** 离开会话：drain 巩固 + 采集收尾 */
  private leaveSession(sessionId: string, workspaceRoot: string): void {
    this.deps.onSessionLeaving?.(sessionId, workspaceRoot)
    this.deps.onSessionCaptureCleanup?.(sessionId)
  }

  private maybeLeaveCurrentSession(store: SessionStore, exceptSessionId?: string): void {
    const prevId = this.state.currentSessionId
    if (!prevId || prevId === exceptSessionId) {
      return
    }
    const prevDetail = store.load(prevId)
    if (prevDetail) {
      this.leaveSession(prevId, prevDetail.workspaceRoot)
    }
  }

  /** 注入广播函数（handler 层负责实际 webContents.send） */
  setBroadcaster(fn: (state: WorkspaceState) => void): void {
    this.broadcaster = fn
  }

  /** 主进程 Agent 轮次进行中时拒绝分叉类操作 */
  private assertNotAgentExecuting(): void {
    if (isAgentTurnInProgress()) {
      throw new Error('生成中，请先停止当前回复')
    }
  }

  /**
   * 递增 messagesRevision 并广播。用于切分支、分叉轮次结束补 branch 元信息、desync 强制重拉。
   */
  bumpMessagesRevision(): WorkspaceState {
    this.clearTier1BranchContext()
    this.messagesRevision++
    this.broadcast()
    return this.getState()
  }

  /** desync 时强制 renderer 重拉，再抛稳定契约错误 */
  private failPathDesync(message: string): never {
    this.bumpMessagesRevision()
    throw new Error(message)
  }

  /** 读取当前状态（不广播）；在此处盖上 messagesRevision 与 tier1 上下文 */
  getState(): WorkspaceState {
    return {
      ...this.state,
      messagesRevision: this.messagesRevision,
      tier1BranchContext: this.tier1BranchContext
    }
  }

  /** 分叉/切会话时清除 Tier 1 视图上下文 */
  private clearTier1BranchContext(): void {
    this.tier1BranchContext = null
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
      if (!window) return this.getState()
      const result = await dialog.showOpenDialog(window, {
        title: '选择本地项目工作区',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return this.getState()
      }
      selectedPath = result.filePaths[0]
    }

    // 同步主进程全局路径（供 AgentLoop 等模块使用 workingDir 边界）
    setCurrentProjectPath(selectedPath)
    reloadSkillsForWorkspace(selectedPath)
    this.notifyWorkspaceRootChanged(selectedPath)

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
    pushContextBreakdownForSession(data, this.deps.getMainWindow)
    return this.getState()
  }

  /** 显式创建新会话（使用给定 workspaceRoot，或沿用当前项目） */
  createSession(params: { workspaceRoot: string; mode?: Mode }): WorkspaceState {
    this.clearTier1BranchContext()
    const store = this.deps.getSessionStore()
    this.maybeLeaveCurrentSession(store)
    const data = store.create(params.workspaceRoot, params.mode ?? this.state.currentMode)
    getMainReadState().clear()
    setCurrentProjectPath(params.workspaceRoot)
    this.notifyWorkspaceRootChanged(params.workspaceRoot)
    setCurrentMode(data.mode)

    this.state = {
      currentSessionId: data.id,
      currentProjectPath: params.workspaceRoot,
      currentMode: data.mode,
      availableSessions: store.list()
    }
    this.broadcast()
    pushContextBreakdownForSession(data, this.deps.getMainWindow)
    return this.getState()
  }

  /**
   * 删除会话。
   * 删除的是当前会话时，自动切到剩余列表的第一条；没有剩余会话则清空工作区。
   */
  deleteSession(sessionId: string): WorkspaceState {
    // 该会话有进行中的 Agent 轮次（含编排 run）时禁止删除：
    // 否则 run 变成无主孤儿，持续占用 RunCoordinator 非终态并向已删除会话写数据。
    if (getActiveTurnSessionId() === sessionId) {
      throw new Error('该会话的 Agent 正在运行，请先停止再删除')
    }
    this.clearTier1BranchContext()
    const store = this.deps.getSessionStore()

    const deletingDetail = store.load(sessionId)
    if (deletingDetail) {
      this.leaveSession(sessionId, deletingDetail.workspaceRoot)
    }

    store.delete(sessionId)

    const remaining = store.list()
    const deletingCurrent = this.state.currentSessionId === sessionId

    if (deletingCurrent) {
      if (remaining.length > 0) {
        // 切到剩余的第一条
        const next = remaining[0]
        const detail = store.load(next.id)
        if (detail) {
          getMainReadState().clear()
          setCurrentProjectPath(detail.workspaceRoot)
          setCurrentMode(detail.mode)
          this.notifyWorkspaceRootChanged(detail.workspaceRoot)
          this.state = {
            currentSessionId: detail.id,
            currentProjectPath: detail.workspaceRoot,
            currentMode: detail.mode,
            availableSessions: remaining
          }
          pushContextBreakdownForSession(detail, this.deps.getMainWindow)
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
    return this.getState()
  }

  /**
   * 手动重命名会话标题（titleSource 固定为 manual，后续自动截取不再覆盖）。
   */
  renameSession(params: { sessionId: string; title: string }): WorkspaceState {
    const store = this.deps.getSessionStore()
    const trimmed = params.title.trim()
    if (!trimmed) {
      throw new Error('标题不能为空')
    }
    const finalTitle = clampSessionTitle(trimmed)
    store.updateTitle(params.sessionId, finalTitle, 'manual')

    this.state = { ...this.state, availableSessions: store.list() }
    this.broadcast()
    return this.getState()
  }

  /**
   * 刷新侧边栏会话列表并广播（自动生成标题后调用，不走 messagesRevision）。
   */
  refreshAvailableSessions(): WorkspaceState {
    const store = this.deps.getSessionStore()
    this.state = { ...this.state, availableSessions: store.list() }
    this.broadcast()
    return this.getState()
  }

  /** 切换当前会话（并同步主进程项目路径/模式） */
  selectSession(sessionId: string): WorkspaceState {
    this.clearTier1BranchContext()
    const store = this.deps.getSessionStore()
    this.maybeLeaveCurrentSession(store, sessionId)
    const detail = store.load(sessionId)
    if (!detail) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }

    getMainReadState().clear()
    setCurrentProjectPath(detail.workspaceRoot)
    setCurrentMode(detail.mode)
    this.notifyWorkspaceRootChanged(detail.workspaceRoot)

    this.state = {
      currentSessionId: detail.id,
      currentProjectPath: detail.workspaceRoot,
      currentMode: detail.mode,
      availableSessions: store.list()
    }
    this.broadcast()
    pushContextBreakdownForSession(detail, this.deps.getMainWindow)
    return this.getState()
  }
  /** 切换运行模式（并持久化到目标会话） */
  setMode(params: { mode: Mode; sessionId?: string }): WorkspaceState {
    const store = this.deps.getSessionStore()
    const sessionId = params.sessionId ?? this.state.currentSessionId

    if (sessionId) {
      store.updateMode(sessionId, params.mode)
      // 同步 availableSessions 里的 mode 字段
      this.state.availableSessions = store.list()
    }

    // 只有目标会话仍是当前会话时才改全局 currentMode。
    // 编排 run（workflowRunner）会用发起时的 sessionId 调本方法，若用户此刻
    // 已切到别的会话，全局模式不应被后台 run 篡改（否则 UI 模式随机跳变）。
    const targetIsCurrent = !sessionId || sessionId === this.state.currentSessionId
    if (targetIsCurrent) {
      setCurrentMode(params.mode)
      this.state = { ...this.state, currentMode: params.mode }
    }
    this.broadcast()

    // 模式变更可能影响 system prompt 长度，重新推送上下文拆分
    const session = targetIsCurrent && sessionId ? store.load(sessionId) : null
    if (session) {
      pushContextBreakdownForSession(session, this.deps.getMainWindow)
    }
    return this.getState()
  }

  /**
   * 对指定消息 id 集合执行文件物理回退（仅当集合内存在 active checkpoint 时）。
   * 裁剪对话树与 setCurrentLeaf 由调用方负责。
   */
  private revertFileChangesForMessageIds(session: SessionData, messageIds: Set<string>): void {
    if (messageIds.size === 0) return

    const store = this.deps.getSessionStore()
    const checkpointRoot = store.getSessionsDir()
    const allManifests = listManifests(checkpointRoot, session.id)
    const hasActive = allManifests.some(
      m => messageIds.has(m.messageId) && m.status === 'active'
    )
    if (!hasActive) return

    revertWorkspaceForMessageIds(
      checkpointRoot,
      session.workspaceRoot,
      session.id,
      messageIds,
      allManifests
    )
  }

  /**
   * 重新生成 assistant 消息的「分叉准备」步骤。
   *
   * 流程：在激活路径定位 assistant → undo 该条及之后文件改动 →
   * setCurrentLeaf 倒回其父 user 消息 → 清快照；不 bump messagesRevision。
   * renderer 随后以 regenerate 模式 send-message，跳过用户 append，直接流式新回答。
   */
  prepareRegenerate(params: { sessionId: string; messageId: string }): WorkspaceState {
    this.assertNotAgentExecuting()
    this.clearTier1BranchContext()
    const store = this.deps.getSessionStore()
    const { sessionId, messageId } = params
    const session = store.load(sessionId)
    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }

    const activePath = getSessionActiveMessages(session)
    const targetIdx = activePath.findIndex(m => m.id === messageId)
    if (targetIdx === -1) {
      this.failPathDesync('目标消息不在当前激活路径上')
    }
    const target = activePath[targetIdx]!
    if (target.role !== 'assistant') {
      throw new Error('重新生成失败：只能重新生成助手消息')
    }
    const userParentId = target.parentId
    if (!userParentId) {
      throw new Error('重新生成失败：找不到对应的用户消息')
    }
    const userOnPath = activePath[targetIdx - 1]
    if (!userOnPath || userOnPath.id !== userParentId || userOnPath.role !== 'user') {
      throw new Error('重新生成失败：用户消息链不一致')
    }

    this.revertFileChangesForMessageIds(
      session,
      new Set(activePath.slice(targetIdx).map(m => m.id))
    )

    store.setCurrentLeaf(sessionId, userParentId)
    store.clearContextSnapshot(sessionId)
    getMainReadState().clear()

    this.state = {
      ...this.state,
      availableSessions: store.list()
    }
    this.broadcast()
    return this.getState()
  }

  /**
   * 切换到兄弟分支：LCA undo + forward 重放 + setCurrentLeaf + bump revision。
   *
   * @param targetMessageId 翻页器选中的兄弟节点 id（须为当前激活路径上某节点的兄弟）
   */
  switchBranch(params: { sessionId: string; targetMessageId: string }): WorkspaceState {
    this.assertNotAgentExecuting()
    const store = this.deps.getSessionStore()
    const { sessionId, targetMessageId } = params
    const session = store.load(sessionId)
    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }

    const checkpointRoot = store.getSessionsDir()
    const allManifests = listManifests(checkpointRoot, session.id)

    const allMessages = ensureMessageParentChain(session.messages)
    const activePath = getSessionActiveMessages(session)
    const childrenIndex = buildChildrenIndex(allMessages)

    const isReachableSibling = activePath.some(m => {
      const siblings = childrenIndex.get(m.parentId ?? null) ?? []
      return siblings.some(s => s.id === targetMessageId)
    })
    if (!isReachableSibling) {
      this.failPathDesync('目标不在当前可视分支族内')
    }

    const currentLeaf = resolveCurrentLeafId(allMessages, session.currentLeafId)
    const targetLeaf = findSubtreeLeaf(allMessages, targetMessageId)
    let lcaId: string | null = null

    if (currentLeaf && currentLeaf !== targetLeaf) {
      lcaId = findCommonAncestor(allMessages, currentLeaf, targetLeaf)
      const currentPath = computeActivePath(allMessages, currentLeaf)
      const lcaIdx = lcaId ? currentPath.findIndex(m => m.id === lcaId) : -1
      const toRevertIds = new Set(
        lcaIdx === -1
          ? currentPath.map(m => m.id)
          : currentPath.slice(lcaIdx + 1).map(m => m.id)
      )
      this.revertFileChangesForMessageIds(session, toRevertIds)
    }

    // Tier 2：从 LCA 正向重放目标分支 assistant checkpoint
    const targetPath = computeActivePath(allMessages, targetLeaf)
    const targetLcaIdx = lcaId ? targetPath.findIndex(m => m.id === lcaId) : -1
    const forwardAssistantIds = targetPath
      .slice(targetLcaIdx + 1)
      .filter(m => m.role === 'assistant')
      .map(m => m.id)

    let incompleteForwardIds: string[] = []
    if (forwardAssistantIds.length > 0) {
      const forwardResult = applyForwardForMessageIds(
        checkpointRoot,
        session.workspaceRoot,
        session.id,
        forwardAssistantIds,
        allManifests
      )
      incompleteForwardIds = forwardResult.incompleteMessageIds
    }

    const replayableAssistantIds = forwardAssistantIds.filter(id => {
      const manifest = allManifests.find(m => m.messageId === id && m.status === 'active')
      if (!manifest) return false
      return (
        manifest.modifiedFiles.length > 0
        || manifest.createdFiles.length > 0
        || manifest.deletedFiles.length > 0
      )
    })

    store.setCurrentLeaf(sessionId, targetLeaf)
    store.clearContextSnapshot(sessionId)
    getMainReadState().clear()

    this.state = {
      ...this.state,
      availableSessions: store.list()
    }

    const refreshed = store.load(sessionId)
    if (refreshed) {
      const branchPos = getBranchPosition(allMessages, targetMessageId)
      if (incompleteForwardIds.length > 0) {
        this.tier1BranchContext = {
          branchIndex: branchPos.index,
          branchTotal: branchPos.total,
          staleDiffMessageIds: incompleteForwardIds,
          partialReplay:
            incompleteForwardIds.length > 0
            && incompleteForwardIds.length < replayableAssistantIds.length
        }
      } else {
        this.tier1BranchContext = null
      }
      pushContextBreakdownForSession(refreshed, this.deps.getMainWindow)
    } else {
      this.tier1BranchContext = null
    }

    this.messagesRevision++
    this.broadcast()
    return this.getState()
  }

  /**
   * 编辑用户消息并重发的「分叉准备」步骤。
   *
   * 与旧版截断式回退不同：edit-resend 只把激活叶子**倒回分叉点**，旧分支节点原样保留在树里（可在后续阶段切回）。
   *
   * 流程：
   * 1. 在当前激活路径上定位目标，必须是 user 消息。
   * 2. 文件 undo：恢复「目标消息及其之后」区间内 active checkpoint 的改动。
   * 3. setCurrentLeaf 倒回目标消息的父节点（分叉点，可能为 null=编辑首条消息）。
   * 4. 清上下文快照 + readState；广播。
   *
   * 关键设计：**不 bump messagesRevision**。随后由 renderer 乐观截断视图 + 复用普通
   * send-message 流式渲染来驱动 UI；若此处也触发 reload，异步回来的消息会覆盖流式中的新消息。
   * appendMessage 会在 send 时自动把新用户消息的 parentId 设为分叉点，天然形成兄弟分支。
   */
  prepareEditResend(params: { sessionId: string; messageId: string }): WorkspaceState {
    this.assertNotAgentExecuting()
    this.clearTier1BranchContext()
    const store = this.deps.getSessionStore()
    const { sessionId, messageId } = params
    const session = store.load(sessionId)
    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }

    // 1. 在激活路径上定位目标（防 desync：目标必须在当前激活路径上）
    const activePath = getSessionActiveMessages(session)
    const targetIdx = activePath.findIndex(m => m.id === messageId)
    if (targetIdx === -1) {
      this.failPathDesync('目标消息不在当前激活路径上')
    }
    const target = activePath[targetIdx]!
    if (target.role !== 'user') {
      throw new Error('编辑重发失败：只能编辑用户消息')
    }

    // 2. 文件 undo：恢复「目标消息及其之后」区间内仍 active 的 checkpoint
    this.revertFileChangesForMessageIds(
      session,
      new Set(activePath.slice(targetIdx).map(m => m.id))
    )

    // 3. 倒回 currentLeafId 到分叉点（目标用户消息的父；首条消息时为 null）
    store.setCurrentLeaf(sessionId, target.parentId)
    store.clearContextSnapshot(sessionId)
    getMainReadState().clear()

    this.state = {
      ...this.state,
      availableSessions: store.list()
    }
    // 故意不 bump messagesRevision：见方法注释（避免 reload 覆盖随后的流式消息）
    this.broadcast()
    return this.getState()
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

  /** 广播当前状态给 renderer（带最新 messagesRevision） */
  private broadcast(): void {
    this.broadcaster?.(this.getState())
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
