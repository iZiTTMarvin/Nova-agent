import { app } from 'electron'
import { SubagentProjectionService } from '../agent/subagents'
import { loadLlmRegistry } from '../../runtime/model/config'
import type { SubagentModelSnapshot } from '../../shared/subagents'
import { getRunCoordinator } from './RunCoordinatorHost'
import { getSessionStore } from './SessionStoreHost'

let projectionService: SubagentProjectionService | null = null

/**
 * 父会话实际生效模型：主会话 ModelClient 由同一注册表活跃模型装配，
 * 这里读取同一事实源，不另发明第二份配置。
 */
function resolveActiveParentModel(): SubagentModelSnapshot | undefined {
  const registry = loadLlmRegistry(app.getPath('userData'))
  if (!registry) return undefined
  const provider = registry.providers.find(
    (candidate) => candidate.id === registry.activeModel.providerId
  )
  const entry = provider?.models.find(
    (candidate) => candidate.id === registry.activeModel.modelEntryId
  )
  if (!provider || !entry) return undefined
  return { providerId: provider.id, modelId: entry.modelId }
}

export function initSubagentProjectionServiceHost(): SubagentProjectionService {
  if (!projectionService) {
    projectionService = new SubagentProjectionService({
      sessionStore: getSessionStore(),
      runCoordinator: getRunCoordinator(),
      resolveParentModel: resolveActiveParentModel
    })
  }
  return projectionService
}

export function getSubagentProjectionService(): SubagentProjectionService {
  if (!projectionService) {
    throw new Error('SubagentProjectionService 尚未初始化')
  }
  return projectionService
}

export function resetSubagentProjectionServiceHostForTests(): void {
  projectionService = null
}
