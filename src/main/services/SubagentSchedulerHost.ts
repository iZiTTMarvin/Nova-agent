import { SubagentScheduler } from '../../runtime/subagents'

let scheduler: SubagentScheduler | null = null

/** 进程级唯一 scheduler；所有普通 task 与 Workflow consumer 共享同一组 permit。 */
export function getSubagentScheduler(): SubagentScheduler {
  if (!scheduler) {
    scheduler = new SubagentScheduler({
      globalLimit: 4,
      perRootLimit: 3,
      maxQueued: 16,
      waitTimeoutMs: 30_000
    })
  }
  return scheduler
}

export function resetSubagentSchedulerForTests(): void {
  scheduler = null
}
