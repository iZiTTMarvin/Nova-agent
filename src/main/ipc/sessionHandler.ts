/**
 * 会话管理与回退操作 IPC handler
 *
 * 职责：
 * 1. 创建/加载/列表/删除会话（通过 SessionStore）
 * 2. 按文件拒绝（reject-file）：从 checkpoint 恢复单个文件
 * 3. 按消息回退（rollback-message）：回退到某条消息之前的状态
 * 4. 接受文件改动（accept-file）：当前为 no-op，后续 S10 可在此更新 diff 状态
 */
import { ipcMain, app } from 'electron'
import {
  LOAD_SESSIONS,
  LOAD_SESSION,
  CREATE_SESSION,
  ACCEPT_FILE,
  REJECT_FILE,
  ROLLBACK_MESSAGE
} from '../../shared/ipc/channels'
import { SessionStore } from '../../runtime/sessions/SessionStore'
import { rejectFile, revertToMessage, listManifests } from '../../runtime/checkpoints/restore'
import { getCurrentProjectPath } from '../index'
import type { Session, SessionDetail, Message } from '../../shared/session'
import type { Mode } from '../../shared/session'
import type { SessionData, SessionMessage } from '../../runtime/sessions/types'

/** SessionStore 单例，在注册时初始化 */
let sessionStore: SessionStore

/** 将持久化 SessionMessage 转换为共享 Message 格式 */
function toMessage(msg: SessionMessage): Message {
  return {
    id: msg.id,
    sessionId: '', // 将在外层填充
    role: msg.role,
    content: msg.content,
    toolCalls: msg.toolCalls?.map(tc => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments ? JSON.parse(tc.arguments) : {}
    })),
    timestamp: msg.timestamp
  }
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
    return toSessionDetail(data)
  })

  // 创建新会话
  ipcMain.handle(CREATE_SESSION, async (_event, params: { workspaceRoot: string; mode?: Mode }) => {
    const data = sessionStore.create(params.workspaceRoot, params.mode ?? 'default')
    return toSessionDetail(data)
  })

  // 接受文件改动（当前版本为 no-op，后续 S10 diff UI 可扩展）
  ipcMain.handle(ACCEPT_FILE, async () => {
    // 当前版本暂不需要额外操作，文件已在工作区中
  })

  // 按文件拒绝：从 checkpoint 恢复该文件到原始内容
  ipcMain.handle(REJECT_FILE, async (
    _event,
    params: { sessionId: string; messageId: string; filePath: string }
  ) => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) {
      throw new Error('未选择工作区目录')
    }

    const checkpointRoot = sessionStore.getSessionsDir()
    const success = rejectFile(
      checkpointRoot,
      projectPath,
      params.sessionId,
      params.messageId,
      params.filePath
    )

    if (!success) {
      throw new Error('文件拒绝失败：该文件不在当前消息的 checkpoint 中，或属于删除的文件类型')
    }
  })

  // 按消息回退：回退到某条消息之前的状态
  ipcMain.handle(ROLLBACK_MESSAGE, async (
    _event,
    params: { sessionId: string; messageId: string }
  ) => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) {
      throw new Error('未选择工作区目录')
    }

    const checkpointRoot = sessionStore.getSessionsDir()

    // 1. 收集该会话所有 active 状态的 manifest
    const allManifests = listManifests(checkpointRoot, params.sessionId)

    // 2. 执行物理回退（恢复文件、删除 checkpoint 目录）
    const success = revertToMessage(
      checkpointRoot,
      projectPath,
      params.sessionId,
      params.messageId,
      allManifests
    )

    if (!success) {
      throw new Error('回退失败：找不到目标消息对应的 checkpoint')
    }

    // 3. 从会话数据中删除该消息及之后的所有消息
    const session = sessionStore.load(params.sessionId)
    if (session) {
      const targetIdx = session.messages.findIndex(m => m.id === params.messageId)
      if (targetIdx !== -1) {
        session.messages = session.messages.slice(0, targetIdx)
        session.updatedAt = Date.now()
        sessionStore.save(session)
      }
    }
  })
}

/** 获取 SessionStore 实例（供 agentHandler 等模块使用） */
export function getSessionStore(): SessionStore {
  return sessionStore
}
