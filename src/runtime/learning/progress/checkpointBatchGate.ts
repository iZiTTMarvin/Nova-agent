const activeByRun = new Map<string, string>()

export function claimCheckpointSlot(runId: string, checkpointId: string): 'ok' | 'duplicate' | 'conflict' {
  const existing = activeByRun.get(runId)
  if (!existing) {
    activeByRun.set(runId, checkpointId)
    return 'ok'
  }
  if (existing === checkpointId) {
    return 'duplicate'
  }
  return 'conflict'
}

export function releaseCheckpointSlot(runId: string): void {
  activeByRun.delete(runId)
}
