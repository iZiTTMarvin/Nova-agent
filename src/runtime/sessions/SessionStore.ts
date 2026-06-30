/**
 * SessionStore — 会话持久化管理
 *
 * 职责：
 * 1. 创建新会话，分配唯一 ID
 * 2. 保存会话元数据到 AppData/sessions/{sessionId}/session.json
 * 3. 以追加 JSONL 方式保存消息体到 AppData/sessions/{sessionId}/messages.jsonl
 * 4. 加载会话列表摘要（不含消息体，按 updatedAt 降序）
 * 5. 加载完整会话数据（含所有消息，用于历史回放）
 * 6. 删除会话及其所有关联数据
 * 7. 追加消息到会话
 *
 * 设计约束：
 * - 纯 TypeScript 模块，不依赖 Electron API，支持脱离 Electron 单测
 * - 调用方通过构造函数注入 appDataPath（在主进程中为 app.getPath('userData')）
 * - 会话消息以树形存储；激活路径由 currentLeafId + parentId 派生
 * - 消息体追加写，避免 session.json 整份重写造成的 Event Loop 阻塞与写放大
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { SessionSummary, SessionData, SessionMessage, SessionMessageAppend, ContextSnapshot } from './types'
import {
  SESSION_DATA_FILE,
  SESSION_MESSAGES_FILE,
  SESSION_CONTEXT_SNAPSHOT_FILE,
  CONTEXT_SNAPSHOT_VERSION
} from './types'
import type { Mode } from '../../shared/session'
import type { TodoItem } from '../../shared/todo/types'
import { CURRENT_SESSION_SCHEMA_VERSION, migrateSessionFile, migrateSessionData } from './migrations'
import {
  computeActivePath,
  resolveCurrentLeafId,
  ensureMessageParentChain,
  attachBranchMeta
} from './tree'

export class SessionStore {
  private readonly sessionsDir: string

  constructor(appDataPath: string) {
    this.sessionsDir = path.join(appDataPath, 'sessions')
  }

  /** 创建新会话，返回完整会话数据 */
  create(workspaceRoot: string, mode: Mode = 'default'): SessionData {
    const now = Date.now()
    const session: SessionData = {
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
      id: `sess_${randomUUID()}`,
      workspaceRoot,
      mode,
      messages: [],
      currentLeafId: null,
      createdAt: now,
      updatedAt: now
    }

    this.save(session)
    return session
  }

  /**
   * 保存会话数据到磁盘。
   *
   * - session.json 只含元数据（不含 messages），体积小、重写快
   * - messages.jsonl 按当前 session.messages 全量重写（用于截断回退、修改历史消息等场景）
   * - 正常追加消息应使用 appendMessage，避免全量重写
   * - 只改元数据（mode/todos）应使用 saveMetadata，避免碰 messages.jsonl
   */
  save(session: SessionData): void {
    const messages = ensureMessageParentChain(session.messages)
    const currentLeafId = resolveCurrentLeafId(messages, session.currentLeafId)
    const normalized: SessionData = { ...session, messages, currentLeafId }
    this.saveMetadata(normalized)
    writeMessagesJsonl(
      path.join(this.sessionsDir, session.id),
      messages
    )
  }

  /**
   * 只写 session.json 元数据，不碰 messages.jsonl。
   *
   * 用于 mode/todos 等只改元数据的高频操作，避免无意义重写整份消息历史。
   */
  private saveMetadata(session: SessionData): void {
    const dir = path.join(this.sessionsDir, session.id)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const metadata = this.toMetadata(session)
    const filePath = path.join(dir, SESSION_DATA_FILE)
    fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), 'utf8')
  }

  /**
   * 加载完整会话数据，不存在时返回 null。
   * 旧版本会话首次加载时自动迁移到 CURRENT_SESSION_SCHEMA_VERSION（带备份），
   * 迁移失败返回 null（与"文件损坏静默跳过"行为一致），避免阻塞 UI。
   */
  load(sessionId: string): SessionData | null {
    const filePath = path.join(this.sessionsDir, sessionId, SESSION_DATA_FILE)
    if (!fs.existsSync(filePath)) return null

    try {
      // 走迁移入口：迁移前自动备份，已是当前版本则零开销直读
      const migrated = migrateSessionFile(this.sessionsDir, sessionId)
      if (!migrated) {
        // 迁移函数返回 null 仅当文件不存在，这里已确认存在，兜底直接解析
        const content = fs.readFileSync(filePath, 'utf8')
        return this.loadFromMetadataAndJsonl(migrateSessionData(JSON.parse(content)), sessionId)
      }
      return this.loadFromMetadataAndJsonl(migrated, sessionId)
    } catch (err) {
      // 迁移失败：原文件已备份，记录错误后返回 null（与既有"损坏静默跳过"行为一致）
      console.error(`[SessionStore] 加载会话 ${sessionId} 失败:`, err)
      return null
    }
  }

  /**
   * 从 session.json 元数据 + messages.jsonl 组装完整 SessionData。
   */
  private loadFromMetadataAndJsonl(metadata: SessionData, sessionId: string): SessionData {
    const rawMessages = readMessagesJsonl(path.join(this.sessionsDir, sessionId))
    const messages = ensureMessageParentChain(rawMessages)
    const currentLeafId = resolveCurrentLeafId(messages, metadata.currentLeafId)
    return {
      ...metadata,
      messages,
      currentLeafId
    }
  }

  /**
   * 将会话数据转换为只含元数据的结构（用于写入 session.json）。
   * messages 字段被排除，避免重复存储与大文件重写。
   */
  private toMetadata(session: SessionData): Omit<SessionData, 'messages'> & { schemaVersion: number } {
    const { messages: _messages, ...metadata } = session
    return {
      ...metadata,
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION
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
        // list 也走迁移，确保侧边栏展示的会话都是最新结构
        const data = migrateSessionFile(this.sessionsDir, entry.name)
        if (!data) continue
        const messages = readMessagesJsonl(path.join(this.sessionsDir, entry.name))
        const leafId = resolveCurrentLeafId(messages, data.currentLeafId)
        const messageCount = computeActivePath(messages, leafId).length
        summaries.push({
          id: data.id,
          workspaceRoot: data.workspaceRoot,
          mode: data.mode,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          messageCount
        })
      } catch {
        // 损坏的会话文件静默跳过
      }
    }

    // 按 updatedAt 降序排列，最近活跃的排在前面；updatedAt 相同时按 createdAt 降序兜底
    return summaries.sort((a, b) => {
      const byUpdated = b.updatedAt - a.updatedAt
      return byUpdated !== 0 ? byUpdated : b.createdAt - a.createdAt
    })
  }

  /** 删除会话及其关联的 checkpoint 数据 */
  delete(sessionId: string): boolean {
    const sessionDir = path.join(this.sessionsDir, sessionId)
    if (!fs.existsSync(sessionDir)) return false

    fs.rmSync(sessionDir, { recursive: true, force: true })
    return true
  }

  /**
   * 追加消息到会话（自动保存）。
   *
   * 实现为 messages.jsonl 追加一行 + 重写小体积 session.json 元数据，
   * 避免每次追加都重写整个消息数组。
   *
   * 追加前会走 migrateSessionFile 确保旧版会话已完成物理迁移（v0…v3 → v4），
   * 避免隐式依赖"load/list 先跑过"的假设。
   */
  appendMessage(sessionId: string, message: SessionMessageAppend): SessionData | null {
    const dir = path.join(this.sessionsDir, sessionId)
    const sessionFile = path.join(dir, SESSION_DATA_FILE)
    if (!fs.existsSync(sessionFile)) return null

    try {
      // 先走迁移：确保旧版内联 messages 已拆出到 messages.jsonl
      const metadata = migrateSessionFile(this.sessionsDir, sessionId)
      if (!metadata) {
        // 迁移函数返回 null 仅当文件不存在，这里已确认存在，兜底直接解析
        const raw = fs.readFileSync(sessionFile, 'utf8')
        return this.appendMessageToMetadata(
          migrateSessionData(JSON.parse(raw)) as SessionData,
          sessionId,
          message
        )
      }

      return this.appendMessageToMetadata(metadata, sessionId, message)
    } catch (err) {
      console.error(`[SessionStore] 追加消息到会话 ${sessionId} 失败:`, err)
      return null
    }
  }

  /**
   * 向已迁移会话追加一条消息：自动设 parentId、推进 currentLeafId。
   */
  private appendMessageToMetadata(
    metadata: SessionData,
    sessionId: string,
    message: SessionMessageAppend
  ): SessionData {
    const dir = path.join(this.sessionsDir, sessionId)

    const messageWithParent: SessionMessage = {
      ...message,
      parentId: metadata.currentLeafId ?? null
    }

    appendMessagesJsonl(dir, [messageWithParent])

    metadata.currentLeafId = messageWithParent.id
    metadata.updatedAt = Date.now()
    fs.writeFileSync(
      path.join(dir, SESSION_DATA_FILE),
      JSON.stringify(this.toMetadata(metadata), null, 2),
      'utf8'
    )

    return this.loadFromMetadataAndJsonl(metadata, sessionId)
  }

  /**
   * 仅更新 currentLeafId（只写 session.json 元数据，不碰 messages.jsonl）。
   *
   * 用于分叉操作（编辑重发 / 切分支）把激活叶子倒回某个分叉点：
   * - leafId 为某节点 id：下次 appendMessage 的新节点挂到该节点下。
   * - leafId 为 null：倒回「所有消息之前」，下次 appendMessage 成森林新根
   *   （编辑首条用户消息的场景）。
   *
   * 不删除任何消息：旧分支节点原样保留在 messages.jsonl。
   */
  setCurrentLeaf(sessionId: string, leafId: string | null): SessionData | null {
    const session = this.load(sessionId)
    if (!session) return null

    if (leafId !== null && !session.messages.some(m => m.id === leafId)) {
      throw new Error(`[SessionStore] setCurrentLeaf: 叶子 ${leafId} 不在会话 ${sessionId} 中`)
    }

    session.currentLeafId = leafId
    session.updatedAt = Date.now()
    this.saveMetadata(session)
    return session
  }

  /** 更新会话模式并持久化（只写 session.json 元数据，不碰 messages.jsonl） */
  updateMode(sessionId: string, mode: Mode): SessionData | null {
    const session = this.load(sessionId)
    if (!session) return null

    session.mode = mode
    session.updatedAt = Date.now()
    this.saveMetadata(session)
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
    this.saveMetadata(session)
    return { session, previousTodos }
  }

  /** 获取会话目录绝对路径（供 CheckpointManager 使用） */
  getSessionsDir(): string {
    return this.sessionsDir
  }

  /** 写入上下文快照（派生缓存，独立于 session.json） */
  saveContextSnapshot(sessionId: string, snapshot: ContextSnapshot): void {
    const dir = path.join(this.sessionsDir, sessionId)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const filePath = path.join(dir, SESSION_CONTEXT_SNAPSHOT_FILE)
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8')
  }

  /**
   * 加载上下文快照。文件不存在、JSON 损坏或版本不符时返回 null。
   */
  loadContextSnapshot(sessionId: string): ContextSnapshot | null {
    const filePath = path.join(this.sessionsDir, sessionId, SESSION_CONTEXT_SNAPSHOT_FILE)
    if (!fs.existsSync(filePath)) return null

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ContextSnapshot
      if (parsed.version !== CONTEXT_SNAPSHOT_VERSION) return null
      return parsed
    } catch {
      return null
    }
  }

  /** 删除上下文快照文件；不存在时静默返回 */
  clearContextSnapshot(sessionId: string): void {
    const filePath = path.join(this.sessionsDir, sessionId, SESSION_CONTEXT_SNAPSHOT_FILE)
    if (!fs.existsSync(filePath)) return
    fs.unlinkSync(filePath)
  }

  /**
   * 按游标反向分页读取 messages.jsonl 子集（不替换 load() 全量读）。
   *
   * - 无 beforeId：返回最新 limit 条（首屏尾部）
   * - 有 beforeId：返回该 id 之前的 limit 条；id 不存在时返回空且 hasMore=false
   */
  loadMessagesPage(
    sessionId: string,
    options: { beforeId?: string; limit: number }
  ): { messages: SessionMessage[]; hasMore: boolean } | null {
    const filePath = path.join(this.sessionsDir, sessionId, SESSION_DATA_FILE)
    if (!fs.existsSync(filePath)) return null

    try {
      const migrated = migrateSessionFile(this.sessionsDir, sessionId)
      let metadata: SessionData
      if (migrated) {
        metadata = migrated
      } else {
        const content = fs.readFileSync(filePath, 'utf8')
        metadata = migrateSessionData(JSON.parse(content)) as SessionData
      }

      const allMessages = readMessagesJsonl(path.join(this.sessionsDir, sessionId))
      const currentLeafId = resolveCurrentLeafId(allMessages, metadata.currentLeafId)
      const activePath = computeActivePath(allMessages, currentLeafId)
      const page = sliceMessagesPage(activePath, options)
      return {
        messages: attachBranchMeta(page.messages, allMessages),
        hasMore: page.hasMore
      }
    } catch (err) {
      console.error(`[SessionStore] 分页读取会话 ${sessionId} 消息失败:`, err)
      return null
    }
  }
}

/**
 * 读取 messages.jsonl，逐行解析为 SessionMessage 数组。
 * 损坏行跳过，不阻塞整条会话加载。
 */
function readMessagesJsonl(sessionDir: string): SessionMessage[] {
  const filePath = path.join(sessionDir, SESSION_MESSAGES_FILE)
  if (!fs.existsSync(filePath)) return []

  try {
    const content = fs.readFileSync(filePath, 'utf8')
    if (!content.trim()) return []

    const messages: SessionMessage[] = []
    const lines = content.split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        messages.push(JSON.parse(line) as SessionMessage)
      } catch (err) {
        console.warn('[SessionStore] messages.jsonl 损坏行已跳过:', err)
      }
    }
    return messages
  } catch (err) {
    console.error('[SessionStore] 读取 messages.jsonl 失败:', err)
    return []
  }
}

/**
 * 全量重写 messages.jsonl。
 * 用于 save()、截断回退、修改历史消息等需要重写整个消息历史的场景。
 */
function writeMessagesJsonl(sessionDir: string, messages: SessionMessage[]): void {
  const filePath = path.join(sessionDir, SESSION_MESSAGES_FILE)
  if (messages.length === 0) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
    return
  }

  const lines = messages.map(m => JSON.stringify(m)).join('\n')
  fs.writeFileSync(filePath, lines + '\n', 'utf8')
}

/**
 * 追加消息到 messages.jsonl。
 * 文件不存在时自动创建。
 */
function appendMessagesJsonl(sessionDir: string, messages: SessionMessage[]): void {
  if (messages.length === 0) return

  const filePath = path.join(sessionDir, SESSION_MESSAGES_FILE)
  const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
  fs.appendFileSync(filePath, lines, 'utf8')
}


/**
 * 在已解析的消息数组上按游标切片（时间正序）。
 * 供 loadMessagesPage 与单测复用。
 */
export function sliceMessagesPage(
  allMessages: SessionMessage[],
  options: { beforeId?: string; limit: number }
): { messages: SessionMessage[]; hasMore: boolean } {
  const { beforeId, limit } = options
  if (limit <= 0 || allMessages.length === 0) {
    return { messages: [], hasMore: false }
  }

  if (!beforeId) {
    if (allMessages.length <= limit) {
      return { messages: allMessages, hasMore: false }
    }
    return {
      messages: allMessages.slice(-limit),
      hasMore: true
    }
  }

  const idx = allMessages.findIndex(m => m.id === beforeId)
  if (idx <= 0) {
    return { messages: [], hasMore: false }
  }

  const start = Math.max(0, idx - limit)
  return {
    messages: allMessages.slice(start, idx),
    hasMore: start > 0
  }
}
