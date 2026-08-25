import { isAbsolute, resolve } from 'path'
import type { PathAccessKind, SessionPathGrant } from '../../../shared/permissions/types'
import {
  type CanonicalPathCache,
  canonicalizeTargetPath,
  isPathWithinRoot
} from './canonicalPath'
import { matchPathGrant, listPathGrantsForAccess } from './sessionPathGrants'

export type PathAccessResolution =
  | {
      ok: true
      canonical: string
      scope: 'workspace' | 'granted' | 'external'
      grant?: SessionPathGrant
    }
  | { ok: false; reason: string }

export function resolvePathAccess(input: {
  workingDir: string
  inputPath: string
  access: PathAccessKind
  grants?: readonly SessionPathGrant[]
  cache?: CanonicalPathCache
}): PathAccessResolution {
  const workspaceCanon = canonicalizeTargetPath(input.workingDir, input.cache)
  if (!workspaceCanon.ok) {
    return { ok: false, reason: workspaceCanon.reason }
  }

  const resolvedInput = isAbsolute(input.inputPath)
    ? input.inputPath
    : resolve(input.workingDir, input.inputPath)
  const targetCanon = canonicalizeTargetPath(resolvedInput, input.cache)
  if (!targetCanon.ok) {
    return { ok: false, reason: targetCanon.reason }
  }

  if (isPathWithinRoot(workspaceCanon.path, targetCanon.path)) {
    return { ok: true, canonical: targetCanon.path, scope: 'workspace' }
  }

  const grant = matchPathGrant(input.grants ?? [], targetCanon.path, input.access)
  if (grant) {
    return { ok: true, canonical: targetCanon.path, scope: 'granted', grant }
  }

  return { ok: true, canonical: targetCanon.path, scope: 'external' }
}

export function isPathAccessible(input: {
  workingDir: string
  inputPath: string
  access: PathAccessKind
  sessionId?: string
  toolCallId?: string
  cache?: CanonicalPathCache
}): boolean {
  const grants = input.sessionId
    ? listPathGrantsForAccess(input.sessionId, input.toolCallId)
    : []
  const resolved = resolvePathAccess({
    workingDir: input.workingDir,
    inputPath: input.inputPath,
    access: input.access,
    grants,
    cache: input.cache
  })
  return resolved.ok && resolved.scope !== 'external'
}
