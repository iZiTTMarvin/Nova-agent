/**
 * 存储治理 IPC handler（WS3 后端）
 *
 * 提供 renderer → main 的存储管理接口：
 * - 获取占用统计
 * - 清理某会话 / 全部快照
 * - 彻底删除会话
 * - 手动运行 GC
 *
 * 设计约束：
 * - 只操作主进程可访问的本地文件系统
 * - 删除类操作返回具体释放字节数，供 UI 展示
 */
import { app } from 'electron'
import { handle } from './secureIpc'
import { clearSessionWhitelist } from '../../runtime/permissions/PermissionManager'
import {
  STORAGE_USAGE,
  STORAGE_PRUNE_SESSION_CHECKPOINTS,
  STORAGE_PRUNE_ALL_CHECKPOINTS,
  STORAGE_DELETE_SESSION,
  STORAGE_RUN_GC
} from '../../shared/ipc/channels'
import {
  getStorageUsageReport,
  pruneSessionCheckpoints,
  pruneAllCheckpoints,
  deleteSessionCompletely,
  runStartupGc
} from '../../runtime/storage/storageService'
import { loadNovaSettings } from '../../runtime/settings/novaSettings'

export function registerStorageHandler(): void {
  const appDataPath = app.getPath('userData')

  handle(STORAGE_USAGE, async () => {
    return getStorageUsageReport(appDataPath)
  })

  handle(STORAGE_PRUNE_SESSION_CHECKPOINTS, async (_event, params: { sessionId: string }) => {
    return pruneSessionCheckpoints(appDataPath, params.sessionId)
  })

  handle(STORAGE_PRUNE_ALL_CHECKPOINTS, async () => {
    return pruneAllCheckpoints(appDataPath)
  })

  handle(STORAGE_DELETE_SESSION, async (_event, params: { sessionId: string }) => {
    clearSessionWhitelist(params.sessionId)
    return deleteSessionCompletely(appDataPath, params.sessionId)
  })

  handle(STORAGE_RUN_GC, async (_event, params?: { snapshotRetentionDays?: number }) => {
    const days = params?.snapshotRetentionDays ?? loadNovaSettings().snapshotRetentionDays
    return runStartupGc(appDataPath, days)
  })
}

/**
 * 应用启动时静默执行一次 GC。
 * 使用用户设置中的 snapshotRetentionDays，失败仅记录日志不阻塞启动。
 */
export function runStartupStorageGc(): void {
  try {
    const appDataPath = app.getPath('userData')
    const days = loadNovaSettings().snapshotRetentionDays
    const result = runStartupGc(appDataPath, days)
    if (result.freedBytes > 0) {
      console.log(`[StorageGC] 启动清理完成: 释放 ${result.freedBytes} bytes, 影响 ${result.affectedSessions} 个会话`)
    }
  } catch (err) {
    console.error('[StorageGC] 启动清理失败:', err)
  }
}
