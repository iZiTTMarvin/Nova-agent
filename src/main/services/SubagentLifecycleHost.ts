import { SubagentLifecycleCoordinator } from '../../runtime/subagents'
import { getRunCoordinator, getRunExecutionRegistry } from './RunCoordinatorHost'
import { getSessionStore } from './SessionStoreHost'
import { getSubagentScheduler } from './SubagentSchedulerHost'

let subagentsShuttingDown = false

/** 退出流程开始后后台派遣不再进入执行。 */
export function markSubagentsShuttingDown(): void {
  subagentsShuttingDown = true
}

export function isSubagentsShuttingDown(): boolean {
  return subagentsShuttingDown
}

export function getSubagentLifecycleCoordinator(): SubagentLifecycleCoordinator {
  return new SubagentLifecycleCoordinator(
    getSessionStore(),
    getRunCoordinator(),
    getRunExecutionRegistry(),
    getSubagentScheduler()
  )
}

export async function interruptActiveSubagentsOnShutdown(): Promise<number> {
  const interrupted = await getSubagentLifecycleCoordinator().interruptActiveChildrenOnShutdown()
  return interrupted.length
}
