import type { MemorySnapshotRecord, SessionData } from './types'
import { MEMORY_SNAPSHOT_MAX_CHARS } from '../memory/memoryConfig'
import { isMemoryExcludedSessionState } from '../memory/MemorySessionExclusion'

export function decodeMemorySnapshot(raw: unknown): MemorySnapshotRecord | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new Error('Invalid memory snapshot')
  const value: Record<string, unknown> = raw
  if (value.formatVersion !== 1 || typeof value.capturedAt !== 'number' || !Number.isFinite(value.capturedAt) || value.capturedAt < 0) throw new Error('Invalid memory snapshot version or time')
  const reason = value.reason
  if (reason !== 'captured' && reason !== 'empty' && reason !== 'disabled' && reason !== 'excluded' && reason !== 'opt-out' && reason !== 'legacy-session') throw new Error('Invalid memory snapshot reason')
  const text = value.text
  if (reason === 'captured' ? typeof text !== 'string' || !text.trim() || text.length > MEMORY_SNAPSHOT_MAX_CHARS : text !== null) throw new Error('Invalid memory snapshot text')
  const globalCoreCount = value.globalCoreCount
  const projectCoreCount = value.projectCoreCount
  const omittedCoreCount = value.omittedCoreCount
  if (!validCount(globalCoreCount) || !validCount(projectCoreCount) || !validCount(omittedCoreCount)) throw new Error('Invalid memory snapshot counts')
  return { formatVersion: 1, capturedAt: value.capturedAt, text: typeof text === 'string' ? text : null,
    reason, globalCoreCount, projectCoreCount, omittedCoreCount }
}

export function getSessionMemorySnapshotText(session: Pick<SessionData, 'kind' | 'mode' | 'memoryOptOut' | 'memorySnapshot'>, memoryEnabled: boolean): string | undefined {
  return memoryEnabled && !isMemoryExcludedSessionState(session)
    ? session.memorySnapshot?.text ?? undefined : undefined
}

export function getSessionMemorySnapshotSummary(session: Pick<SessionData, 'memorySnapshot'>): import('../../shared/memory/types').MemorySnapshotSummary | undefined {
  const snapshot = session.memorySnapshot
  return snapshot ? { capturedAt: snapshot.capturedAt, globalCoreCount: snapshot.globalCoreCount, projectCoreCount: snapshot.projectCoreCount, omittedCoreCount: snapshot.omittedCoreCount } : undefined
}

function validCount(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
