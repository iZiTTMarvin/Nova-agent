import { SubagentDeliveryCoordinator } from '../../runtime/subagents'
import { getRunCoordinator, getRunExecutionRegistry } from './RunCoordinatorHost'
import { getSessionStore } from './SessionStoreHost'
import { isSubagentsShuttingDown } from './SubagentLifecycleHost'

let coordinator: SubagentDeliveryCoordinator | null = null
let owner: ReturnType<typeof getRunCoordinator> | null = null
let unsubscribe: Array<() => void> = []
let idleRelayCallback: ((sessionId: string) => void) | null = null

export function getSubagentDeliveryCoordinator(): SubagentDeliveryCoordinator {
  const runCoordinator = getRunCoordinator()
  if (coordinator && owner === runCoordinator) return coordinator
  for (const dispose of unsubscribe) dispose()
  unsubscribe = []
  coordinator = new SubagentDeliveryCoordinator({
    runCoordinator,
    sessionStore: getSessionStore(),
    isRunExecutionActive: runId => getRunExecutionRegistry().get(runId) !== null,
    onIdleRelayAvailable: (sessionId) => idleRelayCallback?.(sessionId),
    isRelayAdmissionClosed: isSubagentsShuttingDown
  })
  owner = runCoordinator
  const note = (context: { snapshot: Parameters<SubagentDeliveryCoordinator['noteTerminal']>[0] }) => {
    coordinator!.noteTerminal(context.snapshot)
  }
  unsubscribe = [
    runCoordinator.onTerminalHook('onComplete', note),
    runCoordinator.onTerminalHook('onFail', note),
    runCoordinator.onTerminalHook('onCancel', note),
    runCoordinator.onTerminalHook('onInterrupt', note)
  ]
  return coordinator
}

export function setIdleRelayCallback(callback: ((sessionId: string) => void) | null): void {
  idleRelayCallback = callback
}

export function resetSubagentDeliveryCoordinatorHostForTests(): void {
  for (const dispose of unsubscribe) dispose()
  unsubscribe = []
  coordinator = null
  owner = null
}
