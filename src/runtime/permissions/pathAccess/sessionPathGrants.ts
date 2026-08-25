import type { PathAccessKind, SessionPathGrant } from '../../../shared/permissions/types'
import { canonicalizeTargetPath, isPathWithinRoot, lexicalNormalize } from './canonicalPath'

const sessionGrants = new Map<string, SessionPathGrant[]>()
const executionGrants = new Map<string, SessionPathGrant[]>()

function executionKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}::${toolCallId}`
}

function pathsEqual(left: string, right: string): boolean {
  return lexicalNormalize(left) === lexicalNormalize(right)
}

export function matchPathGrant(
  grants: readonly SessionPathGrant[],
  canonicalPath: string,
  access: PathAccessKind
): SessionPathGrant | undefined {
  for (const grant of grants) {
    if (access === 'write' && grant.access === 'read') continue
    if (grant.match === 'exact') {
      if (pathsEqual(grant.canonicalRoot, canonicalPath)) return grant
      continue
    }
    if (isPathWithinRoot(grant.canonicalRoot, canonicalPath)) return grant
  }
  return undefined
}

export function getSessionPathGrants(sessionId: string): SessionPathGrant[] {
  return sessionGrants.get(sessionId) ?? []
}

export function addSessionPathGrant(sessionId: string, grant: SessionPathGrant): void {
  const current = sessionGrants.get(sessionId) ?? []
  const duplicate = current.some(
    existing =>
      existing.access === grant.access &&
      existing.match === grant.match &&
      existing.origin === grant.origin &&
      pathsEqual(existing.canonicalRoot, grant.canonicalRoot)
  )
  if (duplicate) return
  sessionGrants.set(sessionId, [...current, grant])
}

export function replaceSkillPathGrants(sessionId: string, skillRoots: readonly string[]): void {
  const retained = (sessionGrants.get(sessionId) ?? []).filter(grant => grant.origin !== 'skill')
  const next = [...retained]
  for (const root of skillRoots) {
    const trimmed = root.trim()
    if (!trimmed) continue
    const canonical = canonicalizeTargetPath(trimmed)
    if (!canonical.ok) continue
    next.push({
      canonicalRoot: canonical.path,
      access: 'read',
      match: 'subtree',
      origin: 'skill'
    })
  }
  sessionGrants.set(sessionId, next)
}

export function clearSessionPathGrants(sessionId: string): void {
  sessionGrants.delete(sessionId)
  for (const key of executionGrants.keys()) {
    if (key.startsWith(`${sessionId}::`)) executionGrants.delete(key)
  }
}

export function setExecutionPathGrants(
  sessionId: string,
  toolCallId: string,
  grants: readonly SessionPathGrant[]
): void {
  if (!sessionId || !toolCallId || grants.length === 0) return
  executionGrants.set(executionKey(sessionId, toolCallId), [...grants])
}

export function getExecutionPathGrants(
  sessionId: string,
  toolCallId: string | undefined
): SessionPathGrant[] {
  if (!sessionId || !toolCallId) return []
  return executionGrants.get(executionKey(sessionId, toolCallId)) ?? []
}

export function clearExecutionPathGrants(sessionId: string, toolCallId: string | undefined): void {
  if (!sessionId || !toolCallId) return
  executionGrants.delete(executionKey(sessionId, toolCallId))
}

export function listPathGrantsForAccess(
  sessionId: string,
  toolCallId: string | undefined
): SessionPathGrant[] {
  return [...getSessionPathGrants(sessionId), ...getExecutionPathGrants(sessionId, toolCallId)]
}
