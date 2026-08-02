import { SubagentProjectionService } from '../agent/subagents'
import { getRunCoordinator } from './RunCoordinatorHost'
import { getSessionStore } from './SessionStoreHost'

let projectionService: SubagentProjectionService | null = null

export function initSubagentProjectionServiceHost(): SubagentProjectionService {
  if (!projectionService) {
    projectionService = new SubagentProjectionService({
      sessionStore: getSessionStore(),
      runCoordinator: getRunCoordinator()
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
