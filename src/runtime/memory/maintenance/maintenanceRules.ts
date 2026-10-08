import type { StoredMemoryEntry } from '../markdown/MemoryEntryStore'
import { filterPrivacyText } from '../PrivacyFilter'
import { MEMORY_ALIAS_MAX_CHARS, MEMORY_ALIAS_MAX_COUNT, MEMORY_ARCHIVE_RETENTION_DAYS, MEMORY_CANDIDATE_CONTENT_MAX_CHARS, MEMORY_CANDIDATE_CONTENT_MIN_CHARS, MEMORY_INBOX_MAX_ENTRIES, MEMORY_INBOX_TTL_DAYS, MEMORY_KEY_MAX_CHARS } from '../memoryConfig'

export interface MemoryMergeGroup { ids: string[]; content: string; key: string | null; aliases: string[] }
export interface MemoryMaintenancePlan { merge: MemoryMergeGroup[]; retire: string[] }
const day = 86_400_000

export function selectExpiredMemoryIds(entries: readonly StoredMemoryEntry[], now: number, clearLearned = false): Set<string> {
  if (clearLearned) return new Set(entries.filter(entry => entry.via === 'extract' && ['observed', 'inferred'].includes(entry.record.explicitness)).map(entry => entry.record.id))
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.location === 'inbox' && now - entry.record.lastSeenAt > MEMORY_INBOX_TTL_DAYS * day) ids.add(entry.record.id)
    if (entry.location === 'archive' && entry.record.validTo !== null && now - entry.record.validTo > MEMORY_ARCHIVE_RETENTION_DAYS * day) ids.add(entry.record.id)
  }
  const inbox = entries.filter(entry => entry.location === 'inbox' && !ids.has(entry.record.id))
    .sort((a, b) => a.record.lastSeenAt - b.record.lastSeenAt || a.record.id.localeCompare(b.record.id))
  for (const entry of inbox.slice(0, Math.max(0, inbox.length - MEMORY_INBOX_MAX_ENTRIES))) ids.add(entry.record.id)
  return ids
}

export function validateMemoryMaintenancePlan(raw: unknown, entries: readonly StoredMemoryEntry[]): MemoryMaintenancePlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('merge' in raw) || !Array.isArray(raw.merge) || !('retire' in raw) || !Array.isArray(raw.retire)) throw new Error('Invalid memory maintenance plan')
  const byId = new Map(entries.map(entry => [entry.record.id, entry]))
  const used = new Set<string>()
  const merge: MemoryMergeGroup[] = []
  for (const item of raw.merge) {
    if (!item || typeof item !== 'object' || !('ids' in item) || !Array.isArray(item.ids)) throw new Error('Invalid merge IDs')
    const rawIds: unknown[] = item.ids
    if (rawIds.length < 2 || rawIds.some(id => typeof id !== 'string' || !byId.has(id) || used.has(id))) throw new Error('Invalid merge IDs')
    const ids: string[] = rawIds.filter((id): id is string => typeof id === 'string')
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate merge IDs')
    if (!('content' in item) || typeof item.content !== 'string' || /[\r\n]/.test(item.content) || item.content.trim().length < MEMORY_CANDIDATE_CONTENT_MIN_CHARS || item.content.length > MEMORY_CANDIDATE_CONTENT_MAX_CHARS) throw new Error('Invalid merged content')
    const privacy = filterPrivacyText(item.content)
    if (privacy.hadSensitive || privacy.shouldDiscard) throw new Error('Sensitive merged content')
    const key = 'key' in item ? item.key : null
    if (key !== null && (typeof key !== 'string' || !/^[a-z0-9._-]+$/.test(key) || key.length > MEMORY_KEY_MAX_CHARS)) throw new Error('Invalid merged key')
    const aliases = 'aliases' in item ? item.aliases : []
    if (!Array.isArray(aliases) || aliases.length > MEMORY_ALIAS_MAX_COUNT || aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > MEMORY_ALIAS_MAX_CHARS || /[\r\n]/.test(alias) || filterPrivacyText(alias).hadSensitive || filterPrivacyText(alias).shouldDiscard)) throw new Error('Invalid merged aliases')
    ids.forEach(id => used.add(id))
    merge.push({ ids, content: item.content.trim(), key, aliases: aliases.filter((alias): alias is string => typeof alias === 'string') })
  }
  const retire: string[] = []
  for (const id of raw.retire) {
    if (typeof id !== 'string' || !byId.has(id) || used.has(id)) throw new Error('Invalid retire ID')
    const entry = byId.get(id)!
    if (entry.pinned || entry.record.explicitness === 'user_explicit') throw new Error('Protected memory cannot be retired')
    used.add(id); retire.push(id)
  }
  const liveKeys = new Set(entries.filter(entry => !used.has(entry.record.id) && entry.record.memoryKey !== null).map(entry => entry.record.memoryKey))
  for (const group of merge) if (group.key !== null) {
    if (liveKeys.has(group.key)) throw new Error('Merged key conflicts with another active entry')
    liveKeys.add(group.key)
  }
  return { merge, retire }
}
