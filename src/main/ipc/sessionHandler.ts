/**
 * 会话管理与回退操作 IPC handler
 *
 * 职责：
 * 1. 创建/加载/列表/删除会话（通过 SessionStore）
 * 2. 按文件拒绝（reject-file）：从 checkpoint 恢复单个文件
 * 3. 按消息回退（rollback-message）：回退到某条消息之前的状态
 * 4. 接受文件改动（accept-file）：标记文件已审查
 */
import { ipcMain, app } from 'electron'
import {
  LOAD_SESSIONS,
  LOAD_SESSION,
  CREATE_SESSION,
  DELETE_SESSION,
  ACCEPT_FILE,
  REJECT_FILE,
  ROLLBACK_MESSAGE,
  ACCEPT_ALL_FILES,
  REJECT_ALL_FILES
} from '../../shared/ipc/channels'
import { SessionStore } from '../../runtime/sessions/SessionStore'
import { rejectFile, revertToMessage, listManifests } from '../../runtime/checkpoints/restore'
import { buildMessageDiffState, type MessageDiffsState } from '../../runtime/checkpoints/diffState'
import { setCurrentMode, setCurrentProjectPath } from '../index'
import type { Session, SessionDetail, Message } from '../../shared/session'
import type { Mode } from '../../shared/session'
import type { SessionData, SessionMessage } from '../../runtime/sessions/types'
import { readManifest, writeManifest } from '../../runtime/checkpoints/manifest'
import { GET_MESSAGE_DIFFS } from '../../shared/ipc/channels'
import { toSharedMessage } from './sessionMessageMapper'
import { getWorkspaceService } from '../services/WorkspaceService'
import { getMainReadState } from './agentHandler'

/** SessionStore 单例，在注册时初始化 */
let sessionStore: SessionStore

/** 将持久化 SessionMessage 转换为共享 Message 格式，保留工具调用结果 */
function toMessage(msg: SessionMessage): Message & { _toolCallResults?: Record<string, string> } {
  return toSharedMessage(msg)
}

/** 将持久化 SessionData 转换为共享 Session 摘要格式 */
function toSessionSummary(data: SessionData): Session {
  return {
    id: data.id,
    workspaceRoot: data.workspaceRoot,
    mode: data.mode,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    messageCount: data.messages.length
  }
}

/** 将持久化 SessionData 转换为共享 SessionDetail 格式（含消息列表） */
function toSessionDetail(data: SessionData): SessionDetail {
  return {
    id: data.id,
    workspaceRoot: data.workspaceRoot,
    mode: data.mode,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    messageCount: data.messages.length,
    messages: data.messages.map(msg => ({
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
    return toSessionDetail(data)
  })

  // 创建新会话
  ipcMain.handle(CREATE_SESSION, async (_event, params: { workspaceRoot: string; mode?: Mode }) => {
    const data = sessionStore.create(params.workspaceRoot, params.mode ?? 'default')
    // 新建会话时清除先读后改状态，防止跨会话污染
    getMainReadState().clear()
    // 同步主进程的全局项目路径，确保后续 send-message 等操作使用正确的工作区
    setCurrentProjectPath(params.workspaceRoot)
    setCurrentMode(data.mode)
    return toSessionDetail(data)
  })

  // 删除会话
  ipcMain.handle(DELETE_SESSION, async (_event, params: { sessionId: string }) => {
    const success = sessionStore.delete(params.sessionId)
    if (!success) {
      throw new Error(`会话 ${params.sessionId} 删除失败：会话不存在`)
    }
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

  // 按消息回退：回退到某条消息之前的状态
  ipcMain.handle(ROLLBACK_MESSAGE, async (
    _event,
    params: { sessionId: string; messageId: string }
  ) => {
    // 使用会话绑定的 workspaceRoot 而非全局 currentProjectPath
    const session = sessionStore.load(params.sessionId)
    if (!session) {
      throw new Error(`会话 ${params.sessionId} 不存在`)
    }

    const checkpointRoot = sessionStore.getSessionsDir()

    // 1. 收集该会话所有 active 状态的 manifest
    const allManifests = listManifests(checkpointRoot, params.sessionId)

    // 2. 执行物理回退（恢复文件、删除 checkpoint 目录）
    const success = revertToMessage(
      checkpointRoot,
      session.workspaceRoot,
      params.sessionId,
      params.messageId,
      allManifests
    )

    if (!success) {
      throw new Error('回退失败：找不到目标消息对应的 checkpoint')
    }

    // 3. 从会话数据中删除该消息及之后的所有消息
    const targetIdx = session.messages.findIndex(m => m.id === params.messageId)
    if (targetIdx !== -1) {
      session.messages = session.messages.slice(0, targetIdx)
      session.updatedAt = Date.now()
      sessionStore.save(session)
    }

    // 4. 清空 readState：磁盘文件已回退到旧版本，readState 里"已读过"的快照
    // 反映的是回退前的内容，会误导后续 edit 的"外部修改"校验，必须丢弃。
    // I2 修复：之前的实现只回退 session 数据 + 磁盘文件，readState 仍指向新版本，
    // 导致用户回退后继续 edit 会得到错误的 stale 判定或悄悄跳过 stale 校验。
    getMainReadState().clear()
  })
}

/** 获取 SessionStore 实例（供 agentHandler 等模块使用） */
export function getSessionStore(): SessionStore {
  return sessionStore
}
