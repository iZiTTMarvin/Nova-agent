/**
 * 大会话消息索引 — messageId → offset / parentId / activeDepth
 *
 * 热追加路径只维护索引增量，避免每次 append 全量扫 messages.jsonl。
 * 索引文件损坏时可从 jsonl 全量重建。
 */
import * as fs from 'fs'
import * as path from 'path'
import type { SessionMessage } from './types'

/** 单条消息在索引中的元信息（不含正文） */
export interface MessageIndexEntry {
  /** 该行在 messages.jsonl 中的字节偏移（UTF-8） */
  offset: number
  /** 该行字节长度（含末尾 \\n） */
  length: number
  parentId: string | null
  /** 在激活路径上的深度（根=0）；非激活分支节点为 -1 */
  activeDepth: number
}

/** 磁盘上的索引快照 */
export interface MessageIndexSnapshot {
  version: 1
  /** 当前激活叶子；与 session.json.currentLeafId 对齐 */
  currentLeafId: string | null
  /** 激活路径长度（= messageCount） */
  activeCount: number
  /** messages.jsonl 总字节数（用于校验是否过期） */
  fileSize: number
  entries: Record<string, MessageIndexEntry>
}

export const SESSION_MESSAGE_INDEX_FILE = 'messages.index.json'

/** 空索引 */
export function emptyMessageIndex(fileSize = 0): MessageIndexSnapshot {
  return {
    version: 1,
    currentLeafId: null,
    activeCount: 0,
    fileSize,
    entries: {}
  }
}

/**
 * 从已解析的消息数组重建索引。
 * offsets 需与 jsonl 实际字节布局一致（每行 JSON.stringify(msg) + '\\n'）。
 */
export function buildMessageIndex(
  messages: SessionMessage[],
  currentLeafId: string | null
): MessageIndexSnapshot {
  const entries: Record<string, MessageIndexEntry> = {}
  let offset = 0

  for (const msg of messages) {
    const line = JSON.stringify(msg) + '\n'
    const length = Buffer.byteLength(line, 'utf8')
    entries[msg.id] = {
      offset,
      length,
      parentId: msg.parentId ?? null,
      activeDepth: -1
    }
    offset += length
  }

  // 沿激活路径回填 depth
  const activeIds: string[] = []
  let id: string | null = currentLeafId
  const seen = new Set<string>()
  while (id !== null && entries[id] && !seen.has(id)) {
    seen.add(id)
    activeIds.push(id)
    id = entries[id].parentId
  }
  activeIds.reverse()
  for (let depth = 0; depth < activeIds.length; depth++) {
    const entry = entries[activeIds[depth]!]
    if (entry) entry.activeDepth = depth
  }

  return {
    version: 1,
    currentLeafId,
    activeCount: activeIds.length,
    fileSize: offset,
    entries
  }
}

/**
 * 活跃分支热追加：O(1) 更新索引（不扫全图）。
 * 新消息挂在 currentLeaf 下，activeDepth = previousActiveCount。
 *
 * 注意：返回新对象，但 entries 采用「拷贝引用 + 单条插入」而非整表深拷贝字符串化前的
 * 全量重建；真正的常数级落盘由 saveMessageIndexIncremental 负责。
 */
export function appendActiveIndexEntry(
  index: MessageIndexSnapshot,
  message: SessionMessage,
  lineBytes: number
): MessageIndexSnapshot {
  const parentId = message.parentId ?? null
  const activeDepth = index.activeCount
  const offset = index.fileSize

  // 复用原 entries 对象并原地追加，避免每次 {...entries} 复制全部键
  const entries = index.entries
  entries[message.id] = {
    offset,
    length: lineBytes,
    parentId,
    activeDepth
  }

  return {
    version: index.version,
    currentLeafId: message.id,
    activeCount: index.activeCount + 1,
    fileSize: index.fileSize + lineBytes,
    entries
  }
}

/** 读索引；优先 meta+entries.jsonl，回退 legacy 整文件 JSON */
export function loadMessageIndex(sessionDir: string): MessageIndexSnapshot | null {
  const metaPath = path.join(sessionDir, 'messages.index.meta.json')
  const entriesPath = path.join(sessionDir, 'messages.index.entries.jsonl')
  const legacyPath = path.join(sessionDir, SESSION_MESSAGE_INDEX_FILE)

  if (fs.existsSync(metaPath) && fs.existsSync(entriesPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
        version: number
        currentLeafId: string | null
        activeCount: number
        fileSize: number
      }
      if (meta.version !== 1) return null
      const entries: Record<string, MessageIndexEntry> = {}
      const raw = fs.readFileSync(entriesPath, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line) as MessageIndexEntry & { id: string }
          const { id, ...entry } = row
          entries[id] = entry
        } catch {
          /* skip bad line */
        }
      }
      return {
        version: 1,
        currentLeafId: meta.currentLeafId,
        activeCount: meta.activeCount,
        fileSize: meta.fileSize,
        entries
      }
    } catch {
      /* fall through to legacy */
    }
  }

  if (!fs.existsSync(legacyPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as MessageIndexSnapshot
    if (raw.version !== 1 || typeof raw.entries !== 'object' || !raw.entries) return null
    return raw
  } catch {
    return null
  }
}

/**
 * 热路径索引落盘：写小体积 sidecar（leaf/fileSize/activeCount）+ 追加一条 entry 行。
 * 完整 JSON 仅在重建时写入；日常追加不再 stringify 全部 entries。
 */
export function saveMessageIndex(sessionDir: string, index: MessageIndexSnapshot): void {
  const metaPath = path.join(sessionDir, 'messages.index.meta.json')
  const entriesPath = path.join(sessionDir, 'messages.index.entries.jsonl')
  const legacyPath = path.join(sessionDir, SESSION_MESSAGE_INDEX_FILE)

  const meta = {
    version: 1 as const,
    currentLeafId: index.currentLeafId,
    activeCount: index.activeCount,
    fileSize: index.fileSize
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8')

  // 若 entries.jsonl 不存在或与 meta 不同步，回退写完整 legacy（一次性）
  const needFullRewrite =
    !fs.existsSync(entriesPath) ||
    !fs.existsSync(metaPath)

  if (needFullRewrite || shouldRewriteFullIndex(sessionDir, index)) {
    fs.writeFileSync(legacyPath, JSON.stringify(index), 'utf8')
    // 同步重建 entries.jsonl
    const lines: string[] = []
    for (const [id, entry] of Object.entries(index.entries)) {
      lines.push(JSON.stringify({ id, ...entry }))
    }
    fs.writeFileSync(entriesPath, lines.length ? lines.join('\n') + '\n' : '', 'utf8')
    return
  }

  // 增量：只追加最新 leaf 对应的 entry（调用方保证刚 append 的是 currentLeaf）
  const leafId = index.currentLeafId
  if (leafId && index.entries[leafId]) {
    const line = JSON.stringify({ id: leafId, ...index.entries[leafId] }) + '\n'
    fs.appendFileSync(entriesPath, line, 'utf8')
  }
}

/** 当 entries.jsonl 行数与 activeCount 严重偏离时强制全量重写 */
function shouldRewriteFullIndex(sessionDir: string, index: MessageIndexSnapshot): boolean {
  const entriesPath = path.join(sessionDir, 'messages.index.entries.jsonl')
  try {
    if (!fs.existsSync(entriesPath)) return true
    const raw = fs.readFileSync(entriesPath, 'utf8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    // 分叉会产生非激活条目，允许 entries >= activeCount；若少了则重建
    return lines.length < index.activeCount
  } catch {
    return true
  }
}

/**
 * 校验索引与 jsonl 文件大小是否一致；不一致则视为过期。
 */
export function isIndexFresh(index: MessageIndexSnapshot, jsonlFileSize: number): boolean {
  return index.fileSize === jsonlFileSize
}
