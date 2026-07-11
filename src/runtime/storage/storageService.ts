/**
 * 存储治理服务
 *
 * 核心职责：
 * 1. 统计应用数据磁盘占用（按会话拆分：历史 / checkpoint 备份 / artifacts）
 * 2. 提供后台清理接口：删某会话快照、删全部快照、彻底删除会话
 * 3. 启动时自动 GC：清理临时 bash 日志 + 按保留天数清理陈旧 checkpoint files/
 *
 * 设计约束：
 * - 只删 files/ 目录，不删 manifest.json（保留历史记录）
 * - 不删会话历史（session.json / messages.jsonl）
 * - 所有清理操作记录日志，失败不阻塞启动
 */
import {
  existsSync,
  readdirSync,
  statSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { closeSessionIndex } from '../sessions/SessionIndexHost'
import { tmpdir } from 'os'
import type {
  StorageUsageReport,
  StorageCleanupResult,
  SessionStorageBreakdown
} from '../../shared/storage/types'
import { readManifest } from '../checkpoints/manifest'
import type { CheckpointManifest } from '../checkpoints/types'

/** 临时 bash 日志文件名前缀 */
const BASH_TMP_PREFIX = 'nova-bash-'

/** 会话数据文件名 */
const SESSION_DATA_FILE = 'session.json'

/** 上下文快照文件名 */
const CONTEXT_SNAPSHOT_FILE = 'context-snapshot.json'

/** 单个路径的字节大小（文件或递归目录） */
function getPathBytes(entryPath: string): number {
  if (!existsSync(entryPath)) return 0

  try {
    const stats = statSync(entryPath)
    if (!stats.isDirectory()) return stats.size

    let total = 0
    const entries = readdirSync(entryPath, { withFileTypes: true })
    for (const entry of entries) {
      const childPath = join(entryPath, entry.name)
      total += entry.isDirectory() ? getPathBytes(childPath) : statSync(childPath).size
    }
    return total
  } catch {
    return 0
  }
}

/**
 * 获取全应用存储占用统计。
 *
 * @param appDataPath 应用数据根目录（app.getPath('userData')）
 */
export function getStorageUsageReport(appDataPath: string): StorageUsageReport {
  const sessionsDir = join(appDataPath, 'sessions')
  const sessions: SessionStorageBreakdown[] = []
  let orphanBytes = 0
  let totalBytes = 0

  if (!existsSync(sessionsDir)) {
    return { appDataPath, totalBytes: 0, sessions, orphanBytes: 0 }
  }

  const entries = readdirSync(sessionsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      orphanBytes += statSync(join(sessionsDir, entry.name)).size
      continue
    }

    const sessionId = entry.name
    const sessionDir = join(sessionsDir, sessionId)
    const historyBytes = getPathBytes(join(sessionDir, SESSION_DATA_FILE)) +
      getPathBytes(join(sessionDir, CONTEXT_SNAPSHOT_FILE))
    const checkpointsBytes = getCheckpointFilesBytes(sessionDir)
    const artifactsBytes = getPathBytes(join(sessionDir, 'artifacts'))
    const sessionTotal = historyBytes + checkpointsBytes + artifactsBytes

    sessions.push({
      sessionId,
      historyBytes,
      checkpointsBytes,
      artifactsBytes,
      totalBytes: sessionTotal
    })
    totalBytes += sessionTotal
  }

  // 不归入任何会话的顶层文件也计入 orphan
  try {
    const topEntries = readdirSync(appDataPath, { withFileTypes: true })
    for (const entry of topEntries) {
      if (!entry.isDirectory()) {
        orphanBytes += statSync(join(appDataPath, entry.name)).size
      }
    }
  } catch {
    // 忽略顶层读取失败
  }

  totalBytes += orphanBytes

  return { appDataPath, totalBytes, sessions, orphanBytes }
}

/**
 * 统计会话目录下所有 checkpoint files/ 目录的字节数。
 */
function getCheckpointFilesBytes(sessionDir: string): number {
  let total = 0
  if (!existsSync(sessionDir)) return 0

  try {
    const entries = readdirSync(sessionDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const filesDir = join(sessionDir, entry.name, 'files')
      total += getPathBytes(filesDir)
    }
  } catch {
    // 忽略读取失败
  }
  return total
}

/**
 * 清理指定会话的所有 checkpoint 物理备份。
 *
 * 只删除 files/ 目录，保留 manifest.json 并标记 backupPruned。
 */
export function pruneSessionCheckpoints(
  appDataPath: string,
  sessionId: string
): StorageCleanupResult {
  const sessionsDir = join(appDataPath, 'sessions')
  const sessionDir = join(sessionsDir, sessionId)
  let freedBytes = 0
  const details: string[] = []

  if (!existsSync(sessionDir)) {
    return { freedBytes: 0, affectedSessions: 0, details: ['会话不存在'] }
  }

  try {
    const entries = readdirSync(sessionDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const messageId = entry.name
      const filesDir = join(sessionDir, messageId, 'files')
      const manifestPath = join(sessionDir, messageId, 'manifest.json')

      if (existsSync(filesDir)) {
        const bytes = getPathBytes(filesDir)
        rmSync(filesDir, { recursive: true, force: true })
        freedBytes += bytes
        details.push(`${sessionId}/${messageId}/files: -${bytes} bytes`)
      }

      if (existsSync(manifestPath)) {
        try {
          const manifest = readManifest(sessionsDir, sessionId, messageId)
          if (manifest) {
            manifest.backupPruned = true
            manifest.prunedAt = Date.now()
            // 直接写回避免重新序列化整个对象
            writeManifestJson(manifestPath, manifest)
          }
        } catch (err) {
          details.push(`${sessionId}/${messageId}: manifest 标记失败 ${(err as Error).message}`)
        }
      }
    }
  } catch (err) {
    details.push(`清理失败: ${(err as Error).message}`)
  }

  return {
    freedBytes,
    affectedSessions: freedBytes > 0 ? 1 : 0,
    details
  }
}

/**
 * 清理所有会话的 checkpoint 物理备份。
 */
export function pruneAllCheckpoints(appDataPath: string): StorageCleanupResult {
  const sessionsDir = join(appDataPath, 'sessions')
  let totalFreed = 0
  let affectedSessions = 0
  const allDetails: string[] = []

  if (!existsSync(sessionsDir)) {
    return { freedBytes: 0, affectedSessions: 0, details: ['无会话目录'] }
  }

  const entries = readdirSync(sessionsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const result = pruneSessionCheckpoints(appDataPath, entry.name)
    totalFreed += result.freedBytes
    if (result.freedBytes > 0) affectedSessions += 1
    allDetails.push(...result.details)
  }

  return {
    freedBytes: totalFreed,
    affectedSessions,
    details: allDetails
  }
}

/**
 * 彻底删除某个会话及其所有关联数据（历史、快照、artifacts）。
 * 与 SessionStore.delete 相同：删目录前必须先释放 SessionIndex 连接。
 */
export function deleteSessionCompletely(
  appDataPath: string,
  sessionId: string
): StorageCleanupResult {
  const sessionsDir = join(appDataPath, 'sessions')
  const sessionDir = join(sessionsDir, sessionId)

  if (!existsSync(sessionDir)) {
    return { freedBytes: 0, affectedSessions: 0, details: ['会话不存在'] }
  }

  const freedBytes = getPathBytes(sessionDir)
  closeSessionIndex(sessionDir)
  rmSync(sessionDir, { recursive: true, force: true })

  return {
    freedBytes,
    affectedSessions: 1,
    details: [`已彻底删除会话 ${sessionId}: -${freedBytes} bytes`]
  }
}

/**
 * 启动时自动 GC。
 *
 * 1. 删除 os.tmpdir() 下所有 nova-bash-*.log 临时文件
 * 2. 删除超过 snapshotRetentionDays 天的陈旧 checkpoint files/（保留 manifest）
 *
 * @param appDataPath 应用数据根目录
 * @param snapshotRetentionDays 快照保留天数（默认 30）
 */
export function runStartupGc(
  appDataPath: string,
  snapshotRetentionDays: number = 30
): StorageCleanupResult {
  // 0 表示关闭自动 GC（仍清理临时日志）
  const skipSnapshotGc = snapshotRetentionDays <= 0
  const details: string[] = []
  let freedBytes = 0
  let affectedSessions = 0

  // 1. 清理临时 bash 日志
  const tmpCleanup = cleanupBashTempLogs()
  freedBytes += tmpCleanup.freedBytes
  details.push(...tmpCleanup.details)

  // 2. 清理陈旧快照（snapshotRetentionDays <= 0 时跳过）
  const sessionsDir = join(appDataPath, 'sessions')
  if (!skipSnapshotGc && existsSync(sessionsDir)) {
    const cutoff = Date.now() - snapshotRetentionDays * 24 * 60 * 60 * 1000

    try {
      const sessionEntries = readdirSync(sessionsDir, { withFileTypes: true })
      for (const sessionEntry of sessionEntries) {
        if (!sessionEntry.isDirectory()) continue
        const sessionId = sessionEntry.name
        const sessionDir = join(sessionsDir, sessionId)

        let sessionFreed = 0
        const messageEntries = readdirSync(sessionDir, { withFileTypes: true })
        for (const messageEntry of messageEntries) {
          if (!messageEntry.isDirectory()) continue
          const messageId = messageEntry.name
          const filesDir = join(sessionDir, messageId, 'files')
          const manifestPath = join(sessionDir, messageId, 'manifest.json')

          if (!existsSync(filesDir)) continue

          const manifest = readManifest(sessionsDir, sessionId, messageId)
          const age = getManifestAge(manifest)
          if (age > cutoff) continue

          const bytes = getPathBytes(filesDir)
          rmSync(filesDir, { recursive: true, force: true })
          sessionFreed += bytes
          freedBytes += bytes
          details.push(`陈旧快照 ${sessionId}/${messageId}: -${bytes} bytes`)

          // 更新 manifest 标记
          if (manifest) {
            try {
              manifest.backupPruned = true
              manifest.prunedAt = Date.now()
              writeManifestJson(manifestPath, manifest)
            } catch (err) {
              details.push(`manifest 标记失败 ${sessionId}/${messageId}: ${(err as Error).message}`)
            }
          }
        }

        if (sessionFreed > 0) affectedSessions += 1
      }
    } catch (err) {
      details.push(`陈旧快照清理失败: ${(err as Error).message}`)
    }
  }

  return { freedBytes, affectedSessions, details }
}

/**
 * 清理 os.tmpdir() 下 nova-bash-*.log 临时文件。
 */
function cleanupBashTempLogs(): { freedBytes: number; details: string[] } {
  const details: string[] = []
  let freedBytes = 0
  const tmp = tmpdir()

  try {
    const entries = readdirSync(tmp, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.startsWith(BASH_TMP_PREFIX) || !entry.name.endsWith('.log')) continue

      const filePath = join(tmp, entry.name)
      try {
        const bytes = statSync(filePath).size
        unlinkSync(filePath)
        freedBytes += bytes
        details.push(`临时日志 ${entry.name}: -${bytes} bytes`)
      } catch (err) {
        details.push(`临时日志删除失败 ${entry.name}: ${(err as Error).message}`)
      }
    }
  } catch (err) {
    details.push(`临时日志扫描失败: ${(err as Error).message}`)
  }

  return { freedBytes, details }
}

/**
 * 取 manifest 的创建时间作为 checkpoint 年龄。
 * 无 manifest 时返回 0，按最旧处理（保守地允许清理）。
 */
function getManifestAge(manifest: CheckpointManifest | null): number {
  if (manifest?.createdAt) return manifest.createdAt
  return 0
}

/**
 * 将 manifest 对象写回 JSON 文件。
 */
function writeManifestJson(filePath: string, manifest: CheckpointManifest): void {
  writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf-8')
}
