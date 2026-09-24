import {
  BROWSER_MAX_LIVE_PAGES,
  type BrowserErrorCode,
  type BrowserPageIdentity,
  type ObservationIdentity
} from './types'

export interface BrowserIdentityLedgerOptions {
  readonly createBrowserId?: () => string
  readonly createObservationId?: () => string
}

export type BrowserIdentityFailureCode = Extract<
  BrowserErrorCode,
  'not_owner' | 'page_closed' | 'taken_over' | 'stale_observation' | 'resource_limit'
>

export type BrowserIdentityResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: BrowserIdentityFailureCode }

interface PageRecord {
  identity: BrowserPageIdentity
  currentObservationId: string | null
  retired: boolean
}

const MAX_ID_ATTEMPTS = 8

function defaultBrowserId(): string {
  return `brw_${globalThis.crypto.randomUUID()}`
}

function defaultObservationId(): string {
  return `obs_${globalThis.crypto.randomUUID()}`
}

function allocateId(used: Set<string>, factory: () => string, label: string): string {
  for (let i = 0; i < MAX_ID_ATTEMPTS; i++) {
    const id = factory()
    if (typeof id !== 'string' || id.length === 0) continue
    if (used.has(id)) continue
    used.add(id)
    return id
  }
  throw new Error(`无法分配未使用过的${label}`)
}

export interface BrowserIdentityLedger {
  issuePage(binding: {
    sessionId: string
    workspaceKey: string
  }): BrowserIdentityResult<BrowserPageIdentity>
  retire(browserId: string): BrowserIdentityResult<BrowserPageIdentity>
  bumpGeneration(browserId: string): BrowserIdentityResult<BrowserPageIdentity>
  bumpDocumentEpoch(browserId: string): BrowserIdentityResult<BrowserPageIdentity>
  issueObservation(browserId: string): BrowserIdentityResult<ObservationIdentity>
  matchObservation(
    identity: ObservationIdentity,
    sessionId: string
  ): BrowserIdentityResult<ObservationIdentity>
  inspect(browserId: string, sessionId: string): BrowserIdentityResult<BrowserPageIdentity>
}

/**
 * 逻辑 browserId / generation / observationId 的唯一 Owner。
 * 物理槽可复用，已发放或已退役的逻辑身份不能再发给新页面。
 */
export function createBrowserIdentityLedger(
  options: BrowserIdentityLedgerOptions = {}
): BrowserIdentityLedger {
  const createBrowserId = options.createBrowserId ?? defaultBrowserId
  const createObservationId = options.createObservationId ?? defaultObservationId
  const usedBrowserIds = new Set<string>()
  const usedObservationIds = new Set<string>()
  const pages = new Map<string, PageRecord>()

  function lookup(browserId: string, sessionId?: string): BrowserIdentityResult<PageRecord> {
    const record = pages.get(browserId)
    if (!record) return { ok: false, code: 'not_owner' }
    if (sessionId !== undefined && record.identity.sessionId !== sessionId) {
      return { ok: false, code: 'not_owner' }
    }
    if (record.retired) return { ok: false, code: 'page_closed' }
    return { ok: true, value: record }
  }

  function snapshot(record: PageRecord): BrowserPageIdentity {
    return Object.freeze({ ...record.identity })
  }

  return {
    issuePage(binding) {
      if (typeof binding.sessionId !== 'string' || binding.sessionId.length === 0) {
        return { ok: false, code: 'not_owner' }
      }
      if (typeof binding.workspaceKey !== 'string' || binding.workspaceKey.length === 0) {
        return { ok: false, code: 'not_owner' }
      }
      let live = 0
      for (const record of pages.values()) {
        if (!record.retired) live += 1
      }
      if (live >= BROWSER_MAX_LIVE_PAGES) {
        return { ok: false, code: 'resource_limit' }
      }
      const browserId = allocateId(usedBrowserIds, createBrowserId, 'browserId')
      const identity = Object.freeze({
        browserId,
        generation: 1,
        documentEpoch: 1,
        sessionId: binding.sessionId,
        workspaceKey: binding.workspaceKey
      })
      pages.set(browserId, { identity, currentObservationId: null, retired: false })
      return { ok: true, value: identity }
    },

    retire(browserId) {
      const record = pages.get(browserId)
      if (!record) return { ok: false, code: 'not_owner' }
      record.retired = true
      record.currentObservationId = null
      return { ok: true, value: snapshot(record) }
    },

    bumpGeneration(browserId) {
      const found = lookup(browserId)
      if (!found.ok) return found
      found.value.identity = Object.freeze({
        ...found.value.identity,
        generation: found.value.identity.generation + 1
      })
      found.value.currentObservationId = null
      return { ok: true, value: snapshot(found.value) }
    },

    bumpDocumentEpoch(browserId) {
      const found = lookup(browserId)
      if (!found.ok) return found
      found.value.identity = Object.freeze({
        ...found.value.identity,
        documentEpoch: found.value.identity.documentEpoch + 1
      })
      found.value.currentObservationId = null
      return { ok: true, value: snapshot(found.value) }
    },

    issueObservation(browserId) {
      const found = lookup(browserId)
      if (!found.ok) return found
      const observationId = allocateId(usedObservationIds, createObservationId, 'observationId')
      found.value.currentObservationId = observationId
      return {
        ok: true,
        value: Object.freeze({
          browserId: found.value.identity.browserId,
          generation: found.value.identity.generation,
          documentEpoch: found.value.identity.documentEpoch,
          observationId
        })
      }
    },

    matchObservation(identity, sessionId) {
      const found = lookup(identity.browserId, sessionId)
      if (!found.ok) return found
      if (identity.generation !== found.value.identity.generation) {
        return { ok: false, code: 'taken_over' }
      }
      if (identity.documentEpoch !== found.value.identity.documentEpoch) {
        return { ok: false, code: 'stale_observation' }
      }
      if (identity.observationId !== found.value.currentObservationId) {
        return { ok: false, code: 'stale_observation' }
      }
      return {
        ok: true,
        value: Object.freeze({
          browserId: found.value.identity.browserId,
          generation: found.value.identity.generation,
          documentEpoch: found.value.identity.documentEpoch,
          observationId: identity.observationId
        })
      }
    },

    inspect(browserId, sessionId) {
      const found = lookup(browserId, sessionId)
      if (!found.ok) return found
      return { ok: true, value: snapshot(found.value) }
    }
  }
}
