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
import type { SessionSummary, SessionData, SessionMessage, SessionMessageAppend, AppendMessageResult, ContextSnapshot, SessionTitleSource } from './types'
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
  buildMessageIndex,
  isIndexFresh,
  loadMessageIndex,
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
import { ensureSessionIndexFresh, closeSessionIndex } from './SessionIndexHost'
import type { SessionIndexEntryRow } from './SessionIndexDb'
import type { ActivePlanRef } from '../plans'
import { isPlanRelativePath } from '../plans'

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
      const jsonlPath = path.join(dir, SESSION_MESSAGES_FILE)
      const fileSize = fs.existsSync(jsonlPath) ? fs.statSync(jsonlPath).size : 0
      const sqlite = ensureSessionIndexFresh(dir, fileSize, currentLeafId)
      sqlite.rebuildFromMessagesJsonl(dir)
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
   * 确保派生索引与 jsonl 对齐。
   * 优先维护 SQLite；旧 entries.jsonl 仅作只读 fallback，不再写入。
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

    try {
      ensureSessionIndexFresh(sessionDir, fileSize, currentLeafId)
    } catch {
      // SQLite 失败不阻断加载
    }

    // 旧索引只读：若仍 fresh 可复用；否则从内存消息重建快照（不落盘）
    const existing = loadMessageIndex(sessionDir)
    if (existing && isIndexFresh(existing, fileSize)) {
      return existing
    }
    return buildMessageIndex(messages, currentLeafId)
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

  /**
   * 删除会话及其关联的 checkpoint 数据。
   *
   * 生命周期不变量：删目录前必须释放本会话的 SessionIndex 连接
   * （better-sqlite3 + WAL 持有 messages-index.sqlite 句柄时，Windows 无法 unlink）。
   */
  delete(sessionId: string): boolean {
    const sessionDir = this.resolveSessionDir(sessionId)
    if (!fs.existsSync(sessionDir)) return false

    closeSessionIndex(sessionDir)
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
    const result = this.appendMessageFast(sessionId, message)
    if (!result.ok) return null
    const meta = result.meta
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
   * 返回明确结果：appended / already_exists / failed。
   * messageId 唯一：重复 finalize 不得再追加 JSONL。
   */
  appendMessageFast(
    sessionId: string,
    message: SessionMessageAppend
  ): AppendMessageResult {
    let dir: string
    try {
      dir = this.resolveSessionDir(sessionId)
    } catch (err) {
      return {
        ok: false,
        status: 'failed',
        error: err instanceof Error ? err.message : 'invalid sessionId'
      }
    }
    const sessionFile = path.join(dir, SESSION_DATA_FILE)
    if (!fs.existsSync(sessionFile)) {
      return { ok: false, status: 'failed', error: 'session not found' }
    }

    try {
      const metadata = migrateSessionFile(this.sessionsDir, sessionId)
      const base = metadata ?? (migrateSessionData(JSON.parse(fs.readFileSync(sessionFile, 'utf8'))) as SessionData)
      return this.appendMessageFastToMetadata(base, sessionId, message)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[SessionStore] 追加消息到会话 ${sessionId} 失败:`, err)
      return { ok: false, status: 'failed', error: msg }
    }
  }

  /**
   * 活跃分支热追加实现：messageCount = previousActiveCount + 1。
   * 派生索引以 SQLite 为准；不再写入 messages.index.entries.jsonl。
   */
  private appendMessageFastToMetadata(
    metadata: SessionData,
    sessionId: string,
    message: SessionMessageAppend
  ): AppendMessageResult {
    const dir = path.join(this.sessionsDir, sessionId)
    const appendStartedAt = Date.now()

    const normalizedAppend = serializeMessageForDisk({
      ...message,
      parentId: metadata.currentLeafId ?? null
    } as SessionMessage)

    const messageWithParent: SessionMessage = normalizedAppend
    const jsonlPath = path.join(dir, SESSION_MESSAGES_FILE)

    let fileSize = 0
    try {
      if (fs.existsSync(jsonlPath)) fileSize = fs.statSync(jsonlPath).size
    } catch {
      fileSize = 0
    }

    // 唯一性 + activeCount：优先 SQLite；失败则只读旧索引 / 全量扫
    let previousActiveCount: number
    let alreadyExists = false
    try {
      const sqlite = ensureSessionIndexFresh(dir, fileSize, metadata.currentLeafId ?? null)
      if (sqlite.getEntry(messageWithParent.id)) {
        alreadyExists = true
      }
      previousActiveCount =
        typeof metadata.messageCount === 'number'
          ? metadata.messageCount
          : sqlite.activeCount()
    } catch {
      let index = loadMessageIndex(dir)
      if (!index || !isIndexFresh(index, fileSize)) {
        const existing = readMessagesJsonl(dir)
        index = buildMessageIndex(existing, metadata.currentLeafId ?? null)
      }
      if (index.entries[messageWithParent.id]) {
        alreadyExists = true
      }
      previousActiveCount =
        typeof metadata.messageCount === 'number'
          ? metadata.messageCount
          : index.activeCount
    }

    if (alreadyExists) {
      const { messages: _m, ...metaOnly } = metadata
      return { ok: true, status: 'already_exists', meta: metaOnly }
    }

    const line = JSON.stringify(messageWithParent) + '\n'
    const lineBytes = Buffer.byteLength(line, 'utf8')

    // JSONL 追加 + fsync（事实源）；索引失败不得阻断
    const fd = fs.openSync(jsonlPath, 'a')
    try {
      fs.writeSync(fd, line, null, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }

    // 只写 SQLite 派生索引，停写 entries.jsonl / meta / legacy
    try {
      const sqlite = ensureSessionIndexFresh(dir, fileSize, metadata.currentLeafId ?? null)
      sqlite.appendEntry({
        messageId: messageWithParent.id,
        parentId: messageWithParent.parentId ?? null,
        offset: fileSize,
        length: lineBytes,
        activeDepth: previousActiveCount
      })
    } catch (err) {
      console.warn(
        `[SessionStore] SQLite 索引写入失败 session=${sessionId}，将在下次 load/append 时从 jsonl 重建:`,
        err
      )
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
    return { ok: true, status: 'appended', meta: metaOnly }
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
      // 重建 SQLite 派生索引；不再写 entries.jsonl
      try {
        const jsonlPath = path.join(dir, SESSION_MESSAGES_FILE)
        const fileSize = fs.existsSync(jsonlPath) ? fs.statSync(jsonlPath).size : 0
        const sqlite = ensureSessionIndexFresh(dir, fileSize, leaf)
        sqlite.rebuildFromMessagesJsonl(dir)
      } catch (err) {
        console.warn(`[SessionStore] compact 后重建 SQLite 索引失败 session=${sessionId}:`, err)
      }
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
   * 优先走 SQLite 激活链 + 字节范围随机读；失败回退全量 load。
   */
  loadActivePath(sessionId: string): SessionData | null {
    let sessionDir: string
    try {
      sessionDir = this.resolveSessionDir(sessionId)
    } catch {
      return null
    }
    const meta = this.loadMetadataOnly(sessionId)
    if (!meta) return null

    try {
      const loaded = this.loadActivePathViaIndex(sessionDir, meta)
      if (loaded) return loaded
    } catch (err) {
      console.warn(
        `[SessionStore] SQLite loadActivePath 失败，回退全量 load session=${sessionId}:`,
        err
      )
    }

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

    // 分叉后同步派生索引的 activeDepth（SQLite + 下次 ensure 的 leaf 校验）
    try {
      const dir = this.resolveSessionDir(sessionId)
      const jsonlPath = path.join(dir, SESSION_MESSAGES_FILE)
      const fileSize = fs.existsSync(jsonlPath) ? fs.statSync(jsonlPath).size : 0
      const sqlite = ensureSessionIndexFresh(dir, fileSize, leafId)
      // ensure 在 leaf 不匹配时已 rebuild；此处再强制从 jsonl 重建以保证 activeDepth
      sqlite.rebuildFromMessagesJsonl(dir)
    } catch (err) {
      console.warn(`[SessionStore] setCurrentLeaf 后重建 SQLite 索引失败 session=${sessionId}:`, err)
    }

    return session
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

  /** 更新会话模式并持久化（只写 session.json 元数据，不碰 messages.jsonl） */
  updateMode(sessionId: string, mode: Mode): SessionData | null {
    const session = this.load(sessionId)
    if (!session) return null

    session.mode = mode
    session.updatedAt = Date.now()
    this.saveMetadata(session)
    return session
  }

  /** 更新当前会话的 active plan 引用；计划正文不进入会话存储。 */
  updateActivePlan(sessionId: string, plan: ActivePlanRef): SessionData | null {
    if (!isPlanRelativePath(plan.path)) {
      throw new Error(`无效的计划路径: ${plan.path}`)
    }

    const session = this.load(sessionId)
    if (!session) return null

    session.activePlan = { ...plan }
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

  /**
   * 确保会话有 cacheRoutingKey：已有则原样返回，否则懒生成 UUID 并只写元数据。
   * 不重写 messages.jsonl；同一会话树分支共享此 key。
   */
  ensureCacheRoutingKey(sessionId: string): string | null {
    const session = this.load(sessionId)
    if (!session) return null

    if (typeof session.cacheRoutingKey === 'string' && session.cacheRoutingKey.length > 0) {
      return session.cacheRoutingKey
    }

    const key = randomUUID()
    session.cacheRoutingKey = key
    session.updatedAt = Date.now()
    this.saveMetadata(session)
    return key
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
   * list() 用：读 metadata.messageCount；缺失时按 SQLite activeCount（或旧算法）回算并写回。
   */
  private resolveMessageCountForList(sessionId: string, data: SessionData): number {
    const sessionDir = this.resolveSessionDir(sessionId)
    const jsonlPath = path.join(sessionDir, SESSION_MESSAGES_FILE)
    let fileSize = 0
    let jsonlNonEmpty = false
    try {
      if (fs.existsSync(jsonlPath)) {
        fileSize = fs.statSync(jsonlPath).size
        jsonlNonEmpty = fileSize > 0
      }
    } catch {
      fileSize = 0
    }

    // messageCount 缺失或为 0 但 jsonl 非空：按激活路径重算并自愈写回
    if (typeof data.messageCount !== 'number' || (data.messageCount === 0 && jsonlNonEmpty)) {
      let messageCount: number
      try {
        const sqlite = ensureSessionIndexFresh(sessionDir, fileSize, data.currentLeafId ?? null)
        messageCount = sqlite.activeCount()
      } catch {
        const messages = readMessagesJsonl(sessionDir)
        const leafId = resolveCurrentLeafId(messages, data.currentLeafId)
        messageCount = computeMessageCount(messages, leafId)
      }
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
   *
   * 优先：SQLite 激活链 + 字节范围随机读；失败回退全量 readMessagesJsonl。
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

      try {
        const viaIndex = this.loadMessagesPageViaIndex(sessionDir, metadata, options)
        if (viaIndex) return viaIndex
      } catch (err) {
        console.warn(
          `[SessionStore] SQLite 分页失败，回退全量读 session=${sessionId}:`,
          err
        )
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

  /**
   * SQLite 索引驱动的激活路径加载。
   * @returns null 表示索引不可用，调用方应回退
   */
  private loadActivePathViaIndex(
    sessionDir: string,
    metadata: SessionData
  ): SessionData | null {
    const jsonlPath = path.join(sessionDir, SESSION_MESSAGES_FILE)
    const fileSize = fs.existsSync(jsonlPath) ? fs.statSync(jsonlPath).size : 0
    const leafId = metadata.currentLeafId ?? null
    const sqlite = ensureSessionIndexFresh(sessionDir, fileSize, leafId)
    if (!sqlite.isFresh(fileSize)) {
      sqlite.rebuildFromMessagesJsonl(sessionDir)
    }

    const activeCount = sqlite.activeCount()
    const activeRows = sqlite.queryActivePathRange(0, activeCount)
    const activeMessages = this.readAndHydrateMessages(sessionDir, activeRows)

    // branchMeta 需要兄弟节点：按 parentId 从索引取子节点并补读
    const branchContext = this.loadBranchContextMessages(sessionDir, sqlite, activeMessages)
    const withMeta = attachBranchMeta(activeMessages, branchContext)

    return {
      ...metadata,
      messages: withMeta,
      currentLeafId: leafId,
      messageCount: activeMessages.length
    }
  }

  /**
   * SQLite 索引驱动的分页：只随机读当前页字节范围。
   */
  private loadMessagesPageViaIndex(
    sessionDir: string,
    metadata: SessionData,
    options: { beforeId?: string; limit: number }
  ): { messages: SessionMessage[]; hasMore: boolean } | null {
    const jsonlPath = path.join(sessionDir, SESSION_MESSAGES_FILE)
    const fileSize = fs.existsSync(jsonlPath) ? fs.statSync(jsonlPath).size : 0
    const leafId = metadata.currentLeafId ?? null
    const sqlite = ensureSessionIndexFresh(sessionDir, fileSize, leafId)
    if (!sqlite.isFresh(fileSize)) {
      sqlite.rebuildFromMessagesJsonl(sessionDir)
    }

    const activeCount = sqlite.activeCount()
    if (activeCount === 0 || options.limit <= 0) {
      return { messages: [], hasMore: false }
    }

    let fromDepth: number
    let count: number
    let hasMore: boolean

    if (!options.beforeId) {
      fromDepth = Math.max(0, activeCount - options.limit)
      count = activeCount - fromDepth
      hasMore = fromDepth > 0
    } else {
      const before = sqlite.getEntry(options.beforeId)
      if (!before || before.activeDepth === null) {
        return { messages: [], hasMore: false }
      }
      const beforeDepth = before.activeDepth
      if (beforeDepth <= 0) {
        return { messages: [], hasMore: false }
      }
      const start = Math.max(0, beforeDepth - options.limit)
      fromDepth = start
      count = beforeDepth - start
      hasMore = start > 0
    }

    const pageRows = sqlite.queryActivePathRange(fromDepth, count)
    const pageMessages = this.readAndHydrateMessages(sessionDir, pageRows)
    const branchContext = this.loadBranchContextMessages(sessionDir, sqlite, pageMessages)

    return {
      messages: attachBranchMeta(pageMessages, branchContext),
      hasMore
    }
  }

  /** 按索引行随机读 jsonl 字节 → patch → blocks 投影 */
  private readAndHydrateMessages(
    sessionDir: string,
    rows: SessionIndexEntryRow[]
  ): SessionMessage[] {
    if (rows.length === 0) return []
    const raw = readMessagesByRanges(
      sessionDir,
      rows.map(r => ({ offset: r.offset, length: r.length }))
    )
    // 保持与 rows 顺序一致（按 activeDepth）
    const byId = new Map(raw.map(m => [m.id, m]))
    const ordered = rows
      .map(r => byId.get(r.messageId))
      .filter((m): m is SessionMessage => m !== undefined)

    const patches = readMessagePatches(sessionDir)
    const idSet = new Set(ordered.map(m => m.id))
    const relevant = patches.filter(p => idSet.has(p.messageId))
    return applyMessagePatches(ordered, relevant).map(normalizeMessageToBlocksSource)
  }

  /**
   * 为 branchMeta 补齐兄弟节点消息（含非激活分支）。
   * 只读 page 内出现过的 parentId 下的子节点，避免全量扫 jsonl。
   */
  private loadBranchContextMessages(
    sessionDir: string,
    sqlite: { queryByParentId: (parentId: string | null) => SessionIndexEntryRow[]; getEntry: (id: string) => SessionIndexEntryRow | null },
    pageMessages: SessionMessage[]
  ): SessionMessage[] {
    const needed = new Map<string, SessionIndexEntryRow>()
    for (const msg of pageMessages) {
      const self = sqlite.getEntry(msg.id)
      if (self) needed.set(self.messageId, self)
      const parentId = msg.parentId ?? null
      for (const sibling of sqlite.queryByParentId(parentId)) {
        needed.set(sibling.messageId, sibling)
      }
    }
    if (needed.size === 0) return pageMessages

    const already = new Map(pageMessages.map(m => [m.id, m]))
    const missing = [...needed.values()].filter(r => !already.has(r.messageId))
    if (missing.length === 0) return pageMessages

    const extra = this.readAndHydrateMessages(sessionDir, missing)
    return [...pageMessages, ...extra]
  }
}

/**
 * 按字节范围随机读取 messages.jsonl 中的若干行。
 * 供分页 / 激活路径加载使用，避免全量 readFile。
 */
let __jsonlRangeBytesRead = 0
let __jsonlFullReads = 0

/** 测试探针：累计随机读字节数 */
export function __takeJsonlRangeBytesRead(): number {
  const n = __jsonlRangeBytesRead
  __jsonlRangeBytesRead = 0
  return n
}

/** 测试探针：全量 readMessagesJsonl 调用次数 */
export function __takeJsonlFullReads(): number {
  const n = __jsonlFullReads
  __jsonlFullReads = 0
  return n
}

function readMessagesByRanges(
  sessionDir: string,
  ranges: Array<{ offset: number; length: number }>
): SessionMessage[] {
  const filePath = path.join(sessionDir, SESSION_MESSAGES_FILE)
  if (!fs.existsSync(filePath) || ranges.length === 0) return []

  const fd = fs.openSync(filePath, 'r')
  try {
    const messages: SessionMessage[] = []
    for (const { offset, length } of ranges) {
      if (length <= 0) continue
      const buf = Buffer.alloc(length)
      const bytesRead = fs.readSync(fd, buf, 0, length, offset)
      __jsonlRangeBytesRead += bytesRead
      const text = buf.subarray(0, bytesRead).toString('utf8').replace(/\n$/, '')
      if (!text.trim()) continue
      try {
        messages.push(JSON.parse(text) as SessionMessage)
      } catch (err) {
        console.warn('[SessionStore] messages.jsonl 范围读损坏已跳过:', err)
      }
    }
    return messages
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 读取 messages.jsonl，逐行解析为 SessionMessage 数组。
 * 损坏行跳过，不阻塞整条会话加载。
 */
function readMessagesJsonl(sessionDir: string): SessionMessage[] {
  __jsonlFullReads += 1
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
