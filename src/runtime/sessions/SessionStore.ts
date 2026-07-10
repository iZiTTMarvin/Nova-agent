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
import type { SessionSummary, SessionData, SessionMessage, SessionMessageAppend, ContextSnapshot, SessionTitleSource } from './types'
import {
  SESSION_DATA_FILE,
  SESSION_MESSAGES_FILE,
  SESSION_CONTEXT_SNAPSHOT_FILE,
  CONTEXT_SNAPSHOT_VERSION
} from './types'
import { SESSION_PLACEHOLDER_TITLE } from '../../shared/session/title'
import type { Mode } from '../../shared/session'
import type { TodoItem } from '../../shared/todo/types'
import { CURRENT_SESSION_SCHEMA_VERSION, migrateSessionFile, migrateSessionData } from './migrations'
import {
  computeActivePath,
  computeMessageCount,
  resolveCurrentLeafId,
  ensureMessageParentChain,
  attachBranchMeta
} from './tree'
import { atomicWriteFileSync } from '../storage/atomicFile'
import { metricSessionAppend } from '../../shared/diagnostics/metrics'
import {
  appendActiveIndexEntry,
  buildMessageIndex,
  isIndexFresh,
  loadMessageIndex,
  saveMessageIndex,
  type MessageIndexSnapshot
} from './messageIndex'
import {
  appendMessagePatch as appendPatchEvent,
  applyMessagePatches,
  clearMessagePatches,
  readMessagePatches,
  type MessagePatchEvent
} from './messagePatches'
import {
  normalizeMessageToBlocksSource,
  serializeMessageForDisk
} from './messageProjection'

/** 会话 ID 格式：sess_ + UUID，仅允许安全文件名字符 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export class SessionStore {
  private readonly sessionsDir: string

  constructor(appDataPath: string) {
    this.sessionsDir = path.join(appDataPath, 'sessions')
  }

  /**
   * 校验 sessionId 并解析会话目录绝对路径。
   * 所有公共方法拼路径必须经此入口，防止 ../../ 等畸形 ID 逃逸 sessions 目录。
   */
  private resolveSessionDir(sessionId: string): string {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`[SessionStore] 非法 sessionId: ${sessionId}`)
    }
    const resolvedDir = path.resolve(this.sessionsDir, sessionId)
    const normalizedSessions = path.resolve(this.sessionsDir)
    if (
      resolvedDir !== normalizedSessions &&
      !resolvedDir.startsWith(normalizedSessions + path.sep)
    ) {
      throw new Error(`[SessionStore] sessionId 路径越界: ${sessionId}`)
    }
    return resolvedDir
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
      updatedAt: now,
      title: SESSION_PLACEHOLDER_TITLE,
      titleSource: 'placeholder',
      messageCount: 0
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
    const messages = ensureMessageParentChain(session.messages).map(normalizeMessageToBlocksSource)
    const currentLeafId = resolveCurrentLeafId(messages, session.currentLeafId)
    const messageCount = computeMessageCount(messages, currentLeafId)
    const normalized: SessionData = { ...session, messages, currentLeafId, messageCount }
    this.saveMetadata(normalized)
    const dir = this.resolveSessionDir(session.id)
    writeMessagesJsonl(dir, messages)
    clearMessagePatches(dir)
    try {
      saveMessageIndex(dir, buildMessageIndex(messages, currentLeafId))
    } catch {
      // 索引写失败不阻断 save
    }
  }

  /**
   * 只写 session.json 元数据，不碰 messages.jsonl。
   *
   * @param options.recomputeMessageCount 为 true 时按 session.messages + currentLeafId 重算 messageCount
   *   （分叉 setCurrentLeaf 等只改元数据、激活路径长度变化时必须开启）。
   */
  private saveMetadata(
    session: SessionData,
    options?: { recomputeMessageCount?: boolean }
  ): void {
    const dir = this.resolveSessionDir(session.id)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const messageCount = this.resolveMessageCountForMetadata(session, options?.recomputeMessageCount === true)

    const toWrite = { ...session, messageCount }

    const metadata = this.toMetadata(toWrite)
    const filePath = path.join(dir, SESSION_DATA_FILE)
    atomicWriteFileSync(filePath, JSON.stringify(metadata, null, 2), 'utf8')
  }

  /**
   * 加载完整会话数据，不存在时返回 null。
   * 旧版本会话首次加载时自动迁移到 CURRENT_SESSION_SCHEMA_VERSION（带备份），
   * 迁移失败返回 null（与"文件损坏静默跳过"行为一致），避免阻塞 UI。
   */
  load(sessionId: string): SessionData | null {
    let sessionDir: string
    try {
      sessionDir = this.resolveSessionDir(sessionId)
    } catch {
      return null
    }
    const filePath = path.join(sessionDir, SESSION_DATA_FILE)
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
   * 从 session.json 元数据 + messages.jsonl + patches 组装完整 SessionData。
   * 加载时按需把旧消息投影为 blocks 事实源（不强制写回磁盘）。
   */
  private loadFromMetadataAndJsonl(metadata: SessionData, sessionId: string): SessionData {
    const sessionDir = this.resolveSessionDir(sessionId)
    const rawMessages = readMessagesJsonl(sessionDir)
    const patched = applyMessagePatches(rawMessages, readMessagePatches(sessionDir))
    const messages = ensureMessageParentChain(patched).map(normalizeMessageToBlocksSource)
    const currentLeafId = resolveCurrentLeafId(messages, metadata.currentLeafId)
    // 后台确保索引与 jsonl 对齐（损坏时重建）
    this.ensureMessageIndex(sessionDir, messages, currentLeafId)
    return {
      ...metadata,
      messages,
      currentLeafId
    }
  }

  /**
   * 确保大会话索引存在且与 jsonl 文件大小一致；过期则全量重建。
   */
  private ensureMessageIndex(
    sessionDir: string,
    messages: SessionMessage[],
    currentLeafId: string | null
  ): MessageIndexSnapshot {
    const jsonlPath = path.join(sessionDir, SESSION_MESSAGES_FILE)
    let fileSize = 0
    try {
      if (fs.existsSync(jsonlPath)) fileSize = fs.statSync(jsonlPath).size
    } catch {
      fileSize = 0
    }

    const existing = loadMessageIndex(sessionDir)
    if (existing && isIndexFresh(existing, fileSize)) {
      return existing
    }

    const rebuilt = buildMessageIndex(messages, currentLeafId)
    try {
      saveMessageIndex(sessionDir, rebuilt)
    } catch {
      // 索引写失败不阻断加载
    }
    return rebuilt
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
        const messageCount = this.resolveMessageCountForList(entry.name, data)
        summaries.push({
          id: data.id,
          workspaceRoot: data.workspaceRoot,
          mode: data.mode,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          messageCount,
          title: data.title,
          titleSource: data.titleSource
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
    const sessionDir = this.resolveSessionDir(sessionId)
    if (!fs.existsSync(sessionDir)) return false

    fs.rmSync(sessionDir, { recursive: true, force: true })
    return true
  }

  /**
   * 追加消息到会话（自动保存）。
   *
   * 热路径走 appendMessageFast：不扫全图，messageCount = previousActiveCount + 1。
   * 兼容旧调用方：仍返回完整 SessionData（内部按需 loadActivePath）。
   */
  appendMessage(sessionId: string, message: SessionMessageAppend): SessionData | null {
    const meta = this.appendMessageFast(sessionId, message)
    if (!meta) return null
    // 兼容旧调用方：返回含激活路径消息的完整视图
    const active = this.loadActivePath(sessionId)
    if (!active) {
      return {
        ...meta,
        messages: []
      }
    }
    return active
  }

  /**
   * O(1) 热追加：写 jsonl 一行 + 更新小体积元数据 + 增量索引。
   * 不扫全图、不全量重读 messages.jsonl。
   *
   * 返回不含 messages 正文的元数据视图（messageCount 已递增）。
   */
  appendMessageFast(
    sessionId: string,
    message: SessionMessageAppend
  ): Omit<SessionData, 'messages'> | null {
    let dir: string
    try {
      dir = this.resolveSessionDir(sessionId)
    } catch {
      return null
    }
    const sessionFile = path.join(dir, SESSION_DATA_FILE)
    if (!fs.existsSync(sessionFile)) return null

    try {
      const metadata = migrateSessionFile(this.sessionsDir, sessionId)
      const base = metadata ?? (migrateSessionData(JSON.parse(fs.readFileSync(sessionFile, 'utf8'))) as SessionData)
      return this.appendMessageFastToMetadata(base, sessionId, message)
    } catch (err) {
      console.error(`[SessionStore] 追加消息到会话 ${sessionId} 失败:`, err)
      return null
    }
  }

  /**
   * 活跃分支热追加实现：messageCount = previousActiveCount + 1。
   */
  private appendMessageFastToMetadata(
    metadata: SessionData,
    sessionId: string,
    message: SessionMessageAppend
  ): Omit<SessionData, 'messages'> {
    const dir = path.join(this.sessionsDir, sessionId)
    const appendStartedAt = Date.now()

    // 新消息以 blocks 为事实源；落盘只写 blocks，不双写 content/toolCalls
    const normalizedAppend = serializeMessageForDisk({
      ...message,
      parentId: metadata.currentLeafId ?? null
    } as SessionMessage)

    const messageWithParent: SessionMessage = normalizedAppend

    const line = JSON.stringify(messageWithParent) + '\n'
    const lineBytes = Buffer.byteLength(line, 'utf8')
    const jsonlPath = path.join(dir, SESSION_MESSAGES_FILE)

    // 确保索引与当前文件对齐（首次或损坏时重建；热路径尽量 O(1)）
    let fileSize = 0
    try {
      if (fs.existsSync(jsonlPath)) fileSize = fs.statSync(jsonlPath).size
    } catch {
      fileSize = 0
    }
    let index = loadMessageIndex(dir)
    if (!index || !isIndexFresh(index, fileSize)) {
      // 索引过期：轻量重建（仅扫一次，后续追加走增量）
      const existing = readMessagesJsonl(dir)
      index = buildMessageIndex(existing, metadata.currentLeafId ?? null)
    }

    fs.appendFileSync(jsonlPath, line, 'utf8')

    const previousActiveCount =
      typeof metadata.messageCount === 'number'
        ? metadata.messageCount
        : index.activeCount

    index = appendActiveIndexEntry(index, messageWithParent, lineBytes)
    // 与元数据对齐：活跃分支追加时 messageCount = previous + 1
    index.activeCount = previousActiveCount + 1
    index.currentLeafId = messageWithParent.id
    try {
      saveMessageIndex(dir, index)
    } catch {
      // 索引失败不阻断追加
    }

    metadata.currentLeafId = messageWithParent.id
    metadata.updatedAt = Date.now()
    metadata.messageCount = previousActiveCount + 1

    atomicWriteFileSync(
      path.join(dir, SESSION_DATA_FILE),
      JSON.stringify(this.toMetadata(metadata), null, 2),
      'utf8'
    )

    metricSessionAppend(sessionId, Date.now() - appendStartedAt, metadata.messageCount)
    const { messages: _m, ...metaOnly } = metadata
    return metaOnly
  }

  /**
   * 历史后补 verification 等字段：append-only patch，不重写所有消息。
   */
  appendMessagePatch(
    sessionId: string,
    messageId: string,
    patch: MessagePatchEvent['patch']
  ): boolean {
    let dir: string
    try {
      dir = this.resolveSessionDir(sessionId)
    } catch {
      return false
    }
    if (!fs.existsSync(path.join(dir, SESSION_DATA_FILE))) return false

    try {
      appendPatchEvent(dir, {
        type: 'message_patch',
        messageId,
        patch,
        timestamp: Date.now()
      })
      // 触碰 updatedAt，不改 messageCount
      const sessionFile = path.join(dir, SESSION_DATA_FILE)
      const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as SessionData
      raw.updatedAt = Date.now()
      atomicWriteFileSync(sessionFile, JSON.stringify(this.toMetadata({ ...raw, messages: [] }), null, 2), 'utf8')
      return true
    } catch (err) {
      console.error(`[SessionStore] 追加 patch 失败 session=${sessionId}:`, err)
      return false
    }
  }

  /**
   * 空闲合并：把 patches 叠进 messages.jsonl 并清空 patch 文件 + 重建索引。
   * 供后台 compactor 调用；失败不抛。
   */
  compactMessagePatches(sessionId: string): boolean {
    let dir: string
    try {
      dir = this.resolveSessionDir(sessionId)
    } catch {
      return false
    }
    const patches = readMessagePatches(dir)
    if (patches.length === 0) return true

    try {
      const base = readMessagesJsonl(dir)
      const merged = applyMessagePatches(base, patches)
      writeMessagesJsonl(dir, merged)
      clearMessagePatches(dir)
      const meta = this.loadMetadataOnly(sessionId)
      const leaf = meta?.currentLeafId ?? merged.at(-1)?.id ?? null
      saveMessageIndex(dir, buildMessageIndex(merged, leaf))
      return true
    } catch (err) {
      console.error(`[SessionStore] compact patches 失败 session=${sessionId}:`, err)
      return false
    }
  }

  /** 只读 session.json 元数据（不含 messages） */
  private loadMetadataOnly(sessionId: string): SessionData | null {
    try {
      const filePath = path.join(this.resolveSessionDir(sessionId), SESSION_DATA_FILE)
      if (!fs.existsSync(filePath)) return null
      return migrateSessionData(JSON.parse(fs.readFileSync(filePath, 'utf8'))) as SessionData
    } catch {
      return null
    }
  }

  /**
   * 加载当前激活路径上的消息（含 patch 叠加与 blocks 投影）。
   */
  loadActivePath(sessionId: string): SessionData | null {
    const full = this.load(sessionId)
    if (!full) return null
    const active = computeActivePath(full.messages, full.currentLeafId)
    return {
      ...full,
      messages: attachBranchMeta(active, full.messages),
      messageCount: active.length
    }
  }

  /**
   * 按游标反向分页读取激活路径子集（别名：与 loadMessagesPage 同语义）。
   */
  loadSessionPage(
    sessionId: string,
    options: { beforeId?: string; limit: number }
  ): { messages: SessionMessage[]; hasMore: boolean } | null {
    return this.loadMessagesPage(sessionId, options)
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
    this.saveMetadata(session, { recomputeMessageCount: true })
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
   * 更新会话标题（只写 session.json 元数据）。
   * 覆盖保护：当前 titleSource 为 manual 时，非 manual 来源的写入会被忽略。
   */
  updateTitle(sessionId: string, title: string, source: SessionTitleSource): SessionData | null {
    const session = this.load(sessionId)
    if (!session) return null

    if (source !== 'manual' && session.titleSource === 'manual') {
      return session
    }

    session.title = title
    session.titleSource = source
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

  /**
   * 登记本会话已触发的 skill 目录为额外只读根（幂等）。
   * 供跨轮 AgentLoop 重建后恢复 extraAllowedRoots。
   */
  addGrantedSkillRoot(sessionId: string, skillDirectory: string): SessionData | null {
    const trimmed = skillDirectory.trim()
    if (!trimmed) return this.load(sessionId)

    const session = this.load(sessionId)
    if (!session) return null

    const existing = Array.isArray(session.grantedSkillRoots) ? session.grantedSkillRoots : []
    if (existing.includes(trimmed)) return session

    session.grantedSkillRoots = [...existing, trimmed]
    session.updatedAt = Date.now()
    this.saveMetadata(session)
    return session
  }

  /** 获取会话目录绝对路径（供 CheckpointManager 使用） */
  getSessionsDir(): string {
    return this.sessionsDir
  }

  /**
   * 写 session.json 前解析 messageCount。
   * - 分叉 setCurrentLeaf 等必须 forceRecompute
   * - 内存里缺字段时（旧会话首次 load 后走 updateMode 等）用 messages 回算，避免把 undefined 写回磁盘
   * - 已有缓存且未强制重算时原样保留（updateMode/title/todos 不改激活路径）
   */
  private resolveMessageCountForMetadata(session: SessionData, forceRecompute: boolean): number {
    if (forceRecompute) {
      return computeMessageCount(session.messages, session.currentLeafId)
    }
    if (typeof session.messageCount === 'number') {
      return session.messageCount
    }
    return computeMessageCount(session.messages, session.currentLeafId)
  }

  /**
   * list() 用：读 metadata.messageCount；缺失时按原算法回算并写回 session.json。
   */
  private resolveMessageCountForList(sessionId: string, data: SessionData): number {
    const messages = readMessagesJsonl(this.resolveSessionDir(sessionId))
    const leafId = resolveCurrentLeafId(messages, data.currentLeafId)

    // messageCount 缺失或为 0 但 jsonl 非空：按激活路径重算并自愈写回
    if (typeof data.messageCount !== 'number' || (data.messageCount === 0 && messages.length > 0)) {
      const messageCount = computeMessageCount(messages, leafId)
      try {
        const withCount: SessionData = { ...data, messageCount }
        this.saveMetadata(withCount)
      } catch {
        // 写回失败不阻塞 list，仍返回正确计数
      }
      return messageCount
    }

    return data.messageCount
  }

  /** 写入上下文快照（派生缓存，独立于 session.json） */
  saveContextSnapshot(sessionId: string, snapshot: ContextSnapshot): void {
    const dir = this.resolveSessionDir(sessionId)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const filePath = path.join(dir, SESSION_CONTEXT_SNAPSHOT_FILE)
    atomicWriteFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8')
  }

  /**
   * 加载上下文快照。文件不存在、JSON 损坏或版本不符时返回 null。
   */
  loadContextSnapshot(sessionId: string): ContextSnapshot | null {
    let filePath: string
    try {
      filePath = path.join(this.resolveSessionDir(sessionId), SESSION_CONTEXT_SNAPSHOT_FILE)
    } catch {
      return null
    }
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
    const filePath = path.join(this.resolveSessionDir(sessionId), SESSION_CONTEXT_SNAPSHOT_FILE)
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
    let sessionDir: string
    try {
      sessionDir = this.resolveSessionDir(sessionId)
    } catch {
      return null
    }
    const filePath = path.join(sessionDir, SESSION_DATA_FILE)
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

      const allMessages = applyMessagePatches(
        readMessagesJsonl(sessionDir),
        readMessagePatches(sessionDir)
      ).map(normalizeMessageToBlocksSource)
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
    // 原子写空文件，避免 unlink 与存在性判断之间的窗口期
    atomicWriteFileSync(filePath, '', 'utf8')
    return
  }

  const lines = messages.map(m => JSON.stringify(m)).join('\n')
  atomicWriteFileSync(filePath, lines + '\n', 'utf8')
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
