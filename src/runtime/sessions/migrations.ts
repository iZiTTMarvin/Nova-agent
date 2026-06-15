/**
 * 会话 Schema 版本与迁移
 *
 * 设计意图：
 * - 给 SessionData 引入 schemaVersion 字段，让旧会话结构通过一次性迁移变成新结构，
 *   运行时不再靠"typeof content === 'string'"之类的补丁兜底兼容。
 * - 迁移是顺序的：v0→v1→v2→…→CURRENT，不支持跨版本跳跃或并行读取。
 * - 迁移前强制备份原文件，失败时保留原文件并抛错，绝不损坏用户数据。
 *
 * 与 PRD §5.5 对齐。
 */
import * as fs from 'fs'
import * as path from 'path'
import type { SessionData, SessionMessage } from './types'
import { SESSION_DATA_FILE } from './types'

/** 当前 schema 版本 */
export const CURRENT_SESSION_SCHEMA_VERSION = 1

/**
 * v0 → v1：规范化历史会话结构。
 *
 * 处理内容：
 * 1. 补 schemaVersion 字段（旧会话没有）。
 * 2. 旧版 content 可能是纯字符串、含 <thinking> 标签的字符串或 SerializableContentBlock[]，
 *    这里只做"最小规范化"——确保字段存在且类型合法，不做语义级转换
 *    （语义转换仍由渲染层 restoreSessionMessages 负责，避免迁移层耦合渲染逻辑）。
 * 3. 确保 messages 数组存在。
 * 4. toolCalls 字段缺省视为空。
 */
function migrateV0ToV1(data: unknown): SessionData {
  const raw = (data ?? {}) as Record<string, unknown>

  const messages = Array.isArray(raw.messages)
    ? (raw.messages as SessionMessage[]).map(normalizeMessageV0)
    : []

  const result: SessionData = {
    schemaVersion: 1,
    id: typeof raw.id === 'string' ? raw.id : '',
    workspaceRoot: typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot : '',
    mode: (raw.mode === 'plan' || raw.mode === 'default' || raw.mode === 'auto'
      ? raw.mode
      : 'default') as SessionData['mode'],
    messages,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now()
  }

  // 保留可选字段（仅当存在时透传）
  if (typeof raw.frozenSystemPrompt === 'string') {
    result.frozenSystemPrompt = raw.frozenSystemPrompt
  }
  if (Array.isArray(raw.todos)) {
    result.todos = raw.todos as SessionData['todos']
  }

  return result
}

/** 规范化单条历史消息：补全缺失字段，确保结构合法 */
function normalizeMessageV0(msg: unknown): SessionMessage {
  const m = (msg ?? {}) as Record<string, unknown>
  return {
    id: typeof m.id === 'string' ? m.id : '',
    role: (m.role === 'user' || m.role === 'assistant' || m.role === 'system' || m.role === 'tool'
      ? m.role
      : 'assistant') as SessionMessage['role'],
    // content 保持原样（string | SerializableContentBlock[]），渲染层负责处理
    content: m.content === undefined ? '' : (m.content as SessionMessage['content']),
    timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
    ...(Array.isArray(m.toolCalls) ? { toolCalls: m.toolCalls as SessionMessage['toolCalls'] } : {}),
    ...(Array.isArray(m.blocks) ? { blocks: m.blocks as SessionMessage['blocks'] } : {}),
    ...(typeof m.toolCallId === 'string' ? { toolCallId: m.toolCallId } : {}),
    ...(typeof m.verificationSummary === 'string' ? { verificationSummary: m.verificationSummary } : {}),
    ...(m.interrupted === true ? { interrupted: true } : {})
  }
}

/** 迁移函数链：索引 = 起始版本 */
const MIGRATIONS: Array<(data: unknown) => SessionData> = [
  migrateV0ToV1 // v0 → v1
]

/**
 * 把任意未知结构的会话数据迁移到 CURRENT_SESSION_SCHEMA_VERSION。
 *
 * - 无 schemaVersion 或 schemaVersion < CURRENT：顺序应用迁移链。
 * - schemaVersion === CURRENT：补字段后原样返回。
 * - schemaVersion > CURRENT（未来版本数据被旧代码读到）：不回滚，按当前结构尽力补全。
 */
export function migrateSessionData(data: unknown): SessionData {
  const raw = (data ?? {}) as Record<string, unknown>
  const rawVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0

  // 已经是当前版本：只做轻量补全（确保 schemaVersion 字段存在）
  if (rawVersion >= CURRENT_SESSION_SCHEMA_VERSION) {
    return { ...(raw as unknown as SessionData), schemaVersion: CURRENT_SESSION_SCHEMA_VERSION }
  }

  // 从 rawVersion 顺序迁移到 CURRENT
  let current: unknown = raw
  for (let v = rawVersion; v < MIGRATIONS.length; v++) {
    const migrate = MIGRATIONS[v]
    if (migrate) {
      current = migrate(current)
    }
  }

  const result = current as unknown as SessionData
  result.schemaVersion = CURRENT_SESSION_SCHEMA_VERSION
  return result
}

/**
 * 迁移会话文件（带备份）。
 *
 * 流程：
 * 1. 读取 session.json 原始内容。
 * 2. 若已是当前版本，直接返回（不写盘、不备份，避免无谓 IO）。
 * 3. 复制原文件为 <sessionId>.json.backup.<timestamp>。
 * 4. 迁移 + 写回。
 * 5. 迁移失败时保留原文件，向上抛错。
 *
 * @returns 迁移后的 SessionData；文件不存在返回 null
 */
export function migrateSessionFile(
  sessionsDir: string,
  sessionId: string
): SessionData | null {
  const filePath = path.join(sessionsDir, sessionId, SESSION_DATA_FILE)
  if (!fs.existsSync(filePath)) return null

  let rawText: string
  try {
    rawText = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch (err) {
    // JSON 损坏：无法迁移，交给上层处理（SessionStore.load 返回 null）
    throw new Error(`会话 ${sessionId} 的 JSON 解析失败，无法迁移: ${(err as Error).message}`)
  }

  // 已经是当前版本：不写盘
  const rawObj = (parsed ?? {}) as Record<string, unknown>
  const rawVersion = typeof rawObj.schemaVersion === 'number' ? rawObj.schemaVersion : 0
  if (rawVersion >= CURRENT_SESSION_SCHEMA_VERSION) {
    return migrateSessionData(parsed)
  }

  // 迁移前备份（覆盖式：同一 session 重复迁移只保留最新备份，避免堆积）
  const backupPath = path.join(
    sessionsDir,
    sessionId,
    `${SESSION_DATA_FILE}.backup.${Date.now()}`
  )
  try {
    fs.copyFileSync(filePath, backupPath)
  } catch (err) {
    throw new Error(`会话 ${sessionId} 迁移前备份失败，已中止: ${(err as Error).message}`)
  }

  // 执行迁移
  const migrated = migrateSessionData(parsed)

  // 写回
  try {
    fs.writeFileSync(filePath, JSON.stringify(migrated, null, 2), 'utf8')
  } catch (err) {
    throw new Error(`会话 ${sessionId} 迁移后写盘失败，原文件已备份: ${(err as Error).message}`)
  }

  return migrated
}
