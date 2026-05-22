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
  DELETE_SESSION,
  ACCEPT_FILE,
  REJECT_FILE,
  ROLLBACK_MESSAGE
} from '../../shared/ipc/channels'
import { SessionStore } from '../../runtime/sessions/SessionStore'
import { rejectFile, revertToMessage, listManifests } from '../../runtime/checkpoints/restore'
import { setCurrentMode, setCurrentProjectPath } from '../index'
import type { Session, SessionDetail, Message } from '../../shared/session'
import type { Mode } from '../../shared/session'
import type { SessionData, SessionMessage } from '../../runtime/sessions/types'
import { readManifest, writeManifest, getFilesDir } from '../../runtime/checkpoints/manifest'
import { computeFileDiff } from '../../shared/diff/compute'
import type { DiffEntry } from '../../shared/diff/types'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { GET_MESSAGE_DIFFS } from '../../shared/ipc/channels'

/** SessionStore 单例，在注册时初始化 */
let sessionStore: SessionStore

/** 将持久化 SessionMessage 转换为共享 Message 格式，保留工具调用结果 */
function toMessage(msg: SessionMessage): Message & { _toolCallResults?: Record<string, string> } {
  // 工具调用结果以额外字段传递，前端从 _toolCallResults 中按 id 取回
  const toolCallResults: Record<string, string> = {}
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      if (tc.result !== undefined) {
        toolCallResults[tc.id] = tc.result
      }
    }
  }

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
    timestamp: msg.timestamp,
    // 非标准字段，前端用此恢复工具调用结果
    _toolCallResults: Object.keys(toolCallResults).length > 0 ? toolCallResults : undefined
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
    // 同步主进程的全局项目路径，确保后续操作使用正确的工作区
    setCurrentProjectPath(data.workspaceRoot)
    setCurrentMode(data.mode)
    return toSessionDetail(data)
  })

  // 创建新会话
  ipcMain.handle(CREATE_SESSION, async (_event, params: { workspaceRoot: string; mode?: Mode }) => {
    const data = sessionStore.create(params.workspaceRoot, params.mode ?? 'default')
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
    if (!manifest) return

    if (!manifest.fileReviews) manifest.fileReviews = {}
    manifest.fileReviews[params.filePath] = 'accepted'
    writeManifest(checkpointRoot, manifest)
  })

  // 获取某条消息的所有文件 diff（含审查状态）
  ipcMain.handle(GET_MESSAGE_DIFFS, async (
    _event,
    params: { sessionId: string; messageId: string }
  ): Promise<{ diffs: DiffEntry[]; reviews: Record<string, 'accepted' | 'rejected'> }> => {
    const session = sessionStore.load(params.sessionId)
    if (!session) {
      throw new Error(`会话 ${params.sessionId} 不存在`)
    }

    const checkpointRoot = sessionStore.getSessionsDir()
    const manifest = readManifest(checkpointRoot, params.sessionId, params.messageId)
    if (!manifest || manifest.status !== 'active') {
      return { diffs: [], reviews: {} }
    }

    const workspaceRoot = session.workspaceRoot
    const filesDir = getFilesDir(checkpointRoot, params.sessionId, params.messageId)
    const diffs: DiffEntry[] = []

    // 修改过的文件：对比备份与当前工作区内容
    for (const relPath of manifest.modifiedFiles) {
      const backupPath = join(filesDir, relPath)
      const currentPath = join(workspaceRoot, relPath)

      if (!existsSync(backupPath)) continue
      const oldContent = readFileSync(backupPath, 'utf-8')
      const newContent = existsSync(currentPath) ? readFileSync(currentPath, 'utf-8') : ''
      diffs.push(computeFileDiff(relPath, oldContent, newContent, 'modified'))
    }

    // 新建的文件：无原始内容，全部为 added
    for (const relPath of manifest.createdFiles) {
      const currentPath = join(workspaceRoot, relPath)
      if (!existsSync(currentPath)) continue
      const newContent = readFileSync(currentPath, 'utf-8')
      diffs.push(computeFileDiff(relPath, '', newContent, 'added'))
    }

    // 删除的文件：从备份读取原始内容
    for (const relPath of manifest.deletedFiles) {
      const backupPath = join(filesDir, relPath)
      if (!existsSync(backupPath)) continue
      const oldContent = readFileSync(backupPath, 'utf-8')
      diffs.push(computeFileDiff(relPath, oldContent, '', 'deleted'))
    }

    return {
      diffs,
      reviews: manifest.fileReviews ?? {}
    }
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

    // 标记文件审查状态为 rejected
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
  })
}

/** 获取 SessionStore 实例（供 agentHandler 等模块使用） */
export function getSessionStore(): SessionStore {
  return sessionStore
}
