import { SubagentLifecycleCoordinator } from '../../runtime/subagents'
import { getRunCoordinator, getRunExecutionRegistry } from './RunCoordinatorHost'
import { getSessionStore } from './SessionStoreHost'
import { getSubagentScheduler } from './SubagentSchedulerHost'

export function getSubagentLifecycleCoordinator(): SubagentLifecycleCoordinator {
  return new SubagentLifecycleCoordinator(
    getSessionStore(),
    getRunCoordinator(),
    getRunExecutionRegistry(),
    getSubagentScheduler()
  )
}

export function interruptActiveSubagentsOnShutdown(): number {
  return getSubagentLifecycleCoordinator().interruptActiveChildrenOnShutdown().length
}
