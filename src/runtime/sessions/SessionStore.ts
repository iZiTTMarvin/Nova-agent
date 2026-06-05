/**
 * SessionStore — 会话持久化管理
 *
 * 职责：
 * 1. 创建新会话，分配唯一 ID
 * 2. 保存会话快照到 AppData/sessions/{sessionId}/session.json
 * 3. 加载会话列表摘要（不含消息体，用于侧边栏展示）
 * 4. 加载完整会话数据（含所有消息，用于历史回放）
 * 5. 删除会话及其所有关联数据
 * 6. 追加消息到会话
 *
 * 设计约束：
 * - 纯 TypeScript 模块，不依赖 Electron API，支持脱离 Electron 单测
 * - 调用方通过构造函数注入 appDataPath（在主进程中为 app.getPath('userData')）
 * - 会话是线性的，不支持分支或合并
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { SessionSummary, SessionData, SessionMessage } from './types'
import { SESSION_DATA_FILE } from './types'
import type { Mode } from '../../shared/session'
import type { TodoItem } from '../../shared/todo/types'

export class SessionStore {
  private readonly sessionsDir: string

  constructor(appDataPath: string) {
    this.sessionsDir = path.join(appDataPath, 'sessions')
  }

  /** 创建新会话，返回完整会话数据 */
  create(workspaceRoot: string, mode: Mode = 'default'): SessionData {
    const now = Date.now()
    const session: SessionData = {
      id: `sess_${randomUUID()}`,
      workspaceRoot,
      mode,
      messages: [],
      createdAt: now,
      updatedAt: now
    }

    this.save(session)
    return session
  }

  /** 保存会话数据到磁盘 */
  save(session: SessionData): void {
    const dir = path.join(this.sessionsDir, session.id)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const filePath = path.join(dir, SESSION_DATA_FILE)
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8')
  }

  /** 加载完整会话数据，不存在时返回 null */
  load(sessionId: string): SessionData | null {
    const filePath = path.join(this.sessionsDir, sessionId, SESSION_DATA_FILE)
    if (!fs.existsSync(filePath)) return null

    try {
      const content = fs.readFileSync(filePath, 'utf8')
      return JSON.parse(content) as SessionData
    } catch {
      return null
    }
  }

  /** 加载所有会话的摘要列表（不含消息体，按 updatedAt 降序） */
  list(): SessionSummary[] {
    if (!fs.existsSync(this.sessionsDir)) return []

    const summaries: SessionSummary[] = []
    const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const filePath = path.join(this.sessionsDir, entry.name, SESSION_DATA_FILE)
      if (!fs.existsSync(filePath)) continue

      try {
        const content = fs.readFileSync(filePath, 'utf8')
        const data = JSON.parse(content) as SessionData
        summaries.push({
          id: data.id,
          workspaceRoot: data.workspaceRoot,
          mode: data.mode,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          messageCount: data.messages.length
        })
      } catch {
        // 损坏的会话文件静默跳过
      }
    }

    // 按 updatedAt 降序排列，最近活跃的排在前面
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 删除会话及其关联的 checkpoint 数据 */
  delete(sessionId: string): boolean {
    const sessionDir = path.join(this.sessionsDir, sessionId)
    if (!fs.existsSync(sessionDir)) return false

    fs.rmSync(sessionDir, { recursive: true, force: true })
    return true
  }

  /** 追加消息到会话（自动保存） */
  appendMessage(sessionId: string, message: SessionMessage): SessionData | null {
    const session = this.load(sessionId)
    if (!session) return null

    session.messages.push(message)
    session.updatedAt = Date.now()
    this.save(session)
    return session
  }

  /** 更新会话模式并持久化 */
  updateMode(sessionId: string, mode: Mode): SessionData | null {
    const session = this.load(sessionId)
    if (!session) return null

    session.mode = mode
    session.updatedAt = Date.now()
    this.save(session)
    return session
  }

  /**
   * 读取会话级 todo 列表。旧会话（无 todos 字段）默认返回空数组。
   * 这是 todo_write 工具读取"写入前快照"和"恢复视图"时的统一入口。
   */
  getTodos(sessionId: string): TodoItem[] {
    const session = this.load(sessionId)
    if (!session) return []
    return Array.isArray(session.todos) ? session.todos : []
  }

  /**
   * 全量替换会话级 todo 列表（每次写入都是全量替换，与 kilocode 对齐）。
   * 一次 load 同时承担"读取写入前快照"和"写入"两个职责，避免调用方
   * 先 getTodos 再 updateTodos 造成的双次读盘。
   *
   * 返回：{ session, previousTodos }，或会话不存在时返回 null。
   * - session：写入后的完整 SessionData（已 save 落盘）
   * - previousTodos：写入前的旧 todo 列表（空数组等价于"首次创建"）
   */
  updateTodos(
    sessionId: string,
    todos: TodoItem[]
  ): { session: SessionData; previousTodos: TodoItem[] } | null {
    const session = this.load(sessionId)
    if (!session) return null

    const previousTodos = Array.isArray(session.todos) ? session.todos : []
    session.todos = todos
    session.updatedAt = Date.now()
    this.save(session)
    return { session, previousTodos }
  }

  /** 获取会话目录绝对路径（供 CheckpointManager 使用） */
  getSessionsDir(): string {
    return this.sessionsDir
  }
}
