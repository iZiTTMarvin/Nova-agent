import type { Mode } from '../../shared/session/types'
import type { SessionData } from '../sessions/types'

export function isMemoryExcludedMode(mode: Mode): boolean { return mode === 'learn' }

export function isMemoryExcludedSessionState(session: Pick<SessionData, 'kind' | 'mode' | 'memoryOptOut'>): boolean {
  return session.kind !== 'primary' || isMemoryExcludedMode(session.mode) || session.memoryOptOut === true
}
