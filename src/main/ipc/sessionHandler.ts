/**
 * 会话管理与回退操作 IPC handler
 *
 * 职责：
 * 1. 创建/加载/列表/删除会话（通过 SessionStore）
 * 2. 按文件拒绝（reject-file）：从 checkpoint 恢复单个文件
 * 3. 接受文件改动（accept-file）：标记文件已审查
 */
import { ipcMain, app } from 'electron'
import {
  LOAD_SESSIONS,
  LOAD_SESSION,
  LOAD_SESSION_MESSAGES,
  CREATE_SESSION,
  DELETE_SESSION,
  ACCEPT_FILE,
  REJECT_FILE,
  ACCEPT_ALL_FILES,
  REJECT_ALL_FILES
} from '../../shared/ipc/channels'
import { SessionStore } from '../../runtime/sessions/SessionStore'
import { rejectFile } from '../../runtime/checkpoints/restore'
import { buildMessageDiffState } from '../../runtime/checkpoints/diffState'
import type { MessageDiffsState } from '../../shared/diff/types'
import { setCurrentMode, setCurrentProjectPath, getMainWindow } from '../index'
import type { Session, SessionDetail, Message, BranchMeta } from '../../shared/session'
import type { Mode } from '../../shared/session'
import type { SessionData, SessionMessage } from '../../runtime/sessions/types'
import { getSessionActiveMessages, attachBranchMeta, ensureMessageParentChain, resolveCurrentLeafId } from '../../runtime/sessions/tree'
import { readManifest, writeManifest } from '../../runtime/checkpoints/manifest'
import { GET_MESSAGE_DIFFS } from '../../shared/ipc/channels'
import { toSharedMessage } from './sessionMessageMapper'
import { getWorkspaceService } from '../services/WorkspaceService'
import { getMainReadState } from './agentHandler'
import { calculateContextBreakdown } from '../../runtime/agent'
import { getSkillService } from '../services/SkillServiceHost'
import { loadModelConfig } from '../../runtime/model/config'
import { inferContextWindow } from '../../shared/config/types'
import { INITIAL_SESSION_DISPLAY_PAGE_SIZE } from '../../shared/session/messagePagination'
/** SessionStore 单例，在注册时初始化 */
let sessionStore: SessionStore

/** 将持久化 SessionMessage 转换为共享 Message 格式，保留工具调用结果与分支元信息 */
function toMessage(msg: SessionMessage & { branch?: BranchMeta }): Message & { _toolCallResults?: Record<string, string> } {
  const shared = toSharedMessage(msg)
  return msg.branch ? { ...shared, branch: msg.branch } : shared
}

/** 将持久化 SessionData 转换为共享 Session 摘要格式 */
function toSessionSummary(data: SessionData): Session {
  const activeMessages = getSessionActiveMessages(data)
  return {
    id: data.id,
    workspaceRoot: data.workspaceRoot,
    mode: data.mode,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    messageCount: activeMessages.length
  }
}

/** 加载/切换会话时立即计算并推送上下文容量拆分 */
function pushContextBreakdownForSession(session: SessionData): void {
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

/** 将持久化 SessionData 转换为共享 SessionDetail 格式（含消息历史） */
function toSessionDetail(data: SessionData, options?: { tailOnly?: boolean }): SessionDetail {
  const tailOnly = options?.tailOnly ?? false
  const activeMessages = getSessionActiveMessages(data)
  const totalCount = activeMessages.length
  const sourceMessages = tailOnly
    ? activeMessages.slice(-INITIAL_SESSION_DISPLAY_PAGE_SIZE)
    : activeMessages
  const allMessages = ensureMessageParentChain(data.messages)
  const withBranch = attachBranchMeta(sourceMessages, allMessages)
  const currentLeafId = resolveCurrentLeafId(allMessages, data.currentLeafId)

  return {
    id: data.id,
    workspaceRoot: data.workspaceRoot,
    mode: data.mode,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    messageCount: totalCount,
    hasMoreMessagesAbove: tailOnly ? totalCount > sourceMessages.length : undefined,
    currentLeafId,
    messages: withBranch.map(msg => ({
      ...toMessage(msg),
      sessionId: data.id
    }))
  }
}


export function registerSessionHandler(): void {
  const appDataPath = app.getPath('userData')
  sessionStore = new SessionStore(appDataPath)

  // 加载会话列表
  ipcMain.handle(LOAD_SESSIONS, async () => {
    const summaries = sessionStore.list()
    return summaries
  })


  // 加载单个会话的完整数据（含消息历史）
  ipcMain.handle(LOAD_SESSION, async (_event, params: { sessionId: string }) => {
    const data = sessionStore.load(params.sessionId)
    if (!data) {
      throw new Error(`会话 ${params.sessionId} 不存在`)
    }
    // 切换会话时清除先读后改状态，防止跨会话污染
    getMainReadState().clear()
    // 同步主进程的全局项目路径，确保后续操作使用正确的工作区
    setCurrentProjectPath(data.workspaceRoot)
    setCurrentMode(data.mode)
    // 立即推送上下文容量拆分，renderer 无需等待 LLM 调用即可显示
    pushContextBreakdownForSession(data)
    return toSessionDetail(data, { tailOnly: true })
  })

  // 按游标加载更早的消息页（只读，不触发会话切换副作用）
  ipcMain.handle(
    LOAD_SESSION_MESSAGES,
    async (
      _event,
      params: { sessionId: string; beforeId?: string; limit: number }
    ): Promise<{ messages: Message[]; hasMore: boolean }> => {
      const page = sessionStore.loadMessagesPage(params.sessionId, {
        beforeId: params.beforeId,
        limit: params.limit
      })
      if (!page) {
        throw new Error(`会话 ${params.sessionId} 不存在`)
      }
      return {
        messages: page.messages.map(msg => ({
          ...toMessage(msg),
          sessionId: params.sessionId
        })),
        hasMore: page.hasMore
      }
    }
  )

  // 创建新会话
  ipcMain.handle(CREATE_SESSION, async (_event, params: { workspaceRoot: string; mode?: Mode }) => {
    const data = sessionStore.create(params.workspaceRoot, params.mode ?? 'default')
    // 新建会话时清除先读后改状态，防止跨会话污染
    getMainReadState().clear()
    // 同步主进程的全局项目路径，确保后续 send-message 等操作使用正确的工作区
    setCurrentProjectPath(params.workspaceRoot)
    setCurrentMode(data.mode)
    pushContextBreakdownForSession(data)
    return toSessionDetail(data)
  })

  // 接受文件改动：标记为已审查
  ipcMain.handle(ACCEPT_FILE, async (
    _event,
    params: { sessionId: string; messageId: string; filePath: string }
  ): Promise<void> => {
    const checkpointRoot = sessionStore.getSessionsDir()
    const manifest = readManifest(checkpointRoot, params.sessionId, params.messageId)
    if (!manifest) {
      throw new Error('接受文件失败：找不到对应的 checkpoint')
    }

    if (!manifest.fileReviews) manifest.fileReviews = {}
    manifest.fileReviews[params.filePath] = 'accepted'
    writeManifest(checkpointRoot, manifest)
  })

  // 批量接受文件改动（PRD §5.3）：委托给 WorkspaceService
  ipcMain.handle(ACCEPT_ALL_FILES, async (
    _event,
    params: { sessionId: string; messageId: string; filePaths: string[] }
  ): Promise<void> => {
    const ws = getWorkspaceService()
    ws.acceptAllFiles(params.sessionId, params.messageId, params.filePaths)
  })

  // 批量拒绝文件改动（PRD §5.3）：委托给 WorkspaceService
  // 逐个从 checkpoint 恢复，任一失败收集到 failed 数组返回（不中断剩余）
  ipcMain.handle(REJECT_ALL_FILES, async (
    _event,
    params: { sessionId: string; messageId: string; filePaths: string[] }
  ): Promise<{ restored: string[]; failed: Array<{ filePath: string; error: string }> }> => {
    const ws = getWorkspaceService()
    return ws.rejectAllFiles(params.sessionId, params.messageId, params.filePaths)
  })

  // 获取某条消息的所有文件 diff（含审查状态）
  ipcMain.handle(GET_MESSAGE_DIFFS, async (
    _event,
    params: { sessionId: string; messageId: string }
  ): Promise<MessageDiffsState> => {
    const session = sessionStore.load(params.sessionId)
    if (!session) {
      throw new Error(`会话 ${params.sessionId} 不存在`)
    }

    return buildMessageDiffState(
      sessionStore.getSessionsDir(),
      session.workspaceRoot,
      params.sessionId,
      params.messageId
    )
  })

  // 按文件拒绝：从 checkpoint 恢复该文件到原始内容
  ipcMain.handle(REJECT_FILE, async (
    _event,
    params: { sessionId: string; messageId: string; filePath: string }
  ) => {
    // 使用会话绑定的 workspaceRoot 而非全局 currentProjectPath
    const session = sessionStore.load(params.sessionId)
    if (!session) {
      throw new Error(`会话 ${params.sessionId} 不存在`)
    }

    const checkpointRoot = sessionStore.getSessionsDir()
    const success = rejectFile(
      checkpointRoot,
      session.workspaceRoot,
      params.sessionId,
      params.messageId,
      params.filePath
    )

    if (!success) {
      throw new Error('文件拒绝失败：该文件不在当前消息的 checkpoint 中')
    }

    // 标记文件审查状态为 rejected；被拒绝的文件不再参与 diff 计算，
    // 但状态需要保留，供 renderer 展示“已拒绝”痕迹。
    const manifest = readManifest(checkpointRoot, params.sessionId, params.messageId)
    if (manifest) {
      if (!manifest.fileReviews) manifest.fileReviews = {}
      manifest.fileReviews[params.filePath] = 'rejected'
      writeManifest(checkpointRoot, manifest)
    }
  })
}

/** 获取 SessionStore 实例（供 agentHandler 等模块使用） */
export function getSessionStore(): SessionStore {
  return sessionStore
}
