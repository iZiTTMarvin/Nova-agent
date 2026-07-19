/**
 * 跨会话记忆 IPC — scope 文件浏览/编辑与索引维护
 */
import { mkdirSync } from 'fs'
import { shell } from 'electron'
import { handle } from './secureIpc'
import {
  MEMORY_LIST_FILES,
  MEMORY_READ_FILE,
  MEMORY_WRITE_FILE,
  MEMORY_RECONCILE,
  MEMORY_STATS,
  MEMORY_OPEN_DIR
} from '../../shared/ipc/channels'
import { computeWorkspaceHash } from '../../runtime/memory/MemoryPaths'
import { getMemoryService } from '../services/MemoryServiceHost'
import { getWorkspaceService } from '../services/WorkspaceService'
import type {
  MemoryScopeFileEntry,
  MemoryScopeStats,
  MemoryReadFileParams,
  MemoryWriteFileParams
} from '../../shared/memory/types'
import type { ReconcileStats } from '../../shared/memory/types'

/** 从当前工作区解析 scopeId；未打开项目时抛错 */
function requireScopeId(): string {
  const projectPath = getWorkspaceService().getState().currentProjectPath
  if (!projectPath?.trim()) {
    throw new Error('请先打开工作区项目')
  }
  return computeWorkspaceHash(projectPath)
}

export function registerMemoryHandler(): void {
  handle(MEMORY_LIST_FILES, async (): Promise<MemoryScopeFileEntry[]> => {
    const scopeId = requireScopeId()
    return getMemoryService().listScopeFiles(scopeId)
  })

  handle(MEMORY_READ_FILE, async (_event, params: MemoryReadFileParams): Promise<string> => {
    const scopeId = requireScopeId()
    return getMemoryService().readScopeFile(scopeId, params.relPath)
  })

  handle(MEMORY_WRITE_FILE, async (_event, params: MemoryWriteFileParams): Promise<void> => {
    const scopeId = requireScopeId()
    getMemoryService().upsertMarkdown(scopeId, params.relPath, params.content)
  })

  handle(MEMORY_RECONCILE, async (): Promise<ReconcileStats> => {
    const scopeId = requireScopeId()
    return getMemoryService().reconcile(scopeId)
  })

  handle(MEMORY_STATS, async (): Promise<MemoryScopeStats> => {
    const scopeId = requireScopeId()
    return getMemoryService().stats(scopeId)
  })

  handle(MEMORY_OPEN_DIR, async (): Promise<void> => {
    const scopeId = requireScopeId()
    const memoryService = getMemoryService()
    const stats = memoryService.stats(scopeId)
    mkdirSync(stats.scopeDir, { recursive: true })
    const err = await shell.openPath(stats.scopeDir)
    if (err) {
      throw new Error(`无法打开记忆目录：${err}`)
    }
  })
}
