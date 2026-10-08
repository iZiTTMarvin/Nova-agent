import type { StoredMemoryEntry } from '../markdown/MemoryEntryStore'
import type { MemoryKind, ScopeKind } from '../types'
import {
  MEMORY_SNAPSHOT_GLOBAL_CORE_MAX_CHARS, MEMORY_SNAPSHOT_PROJECT_CORE_MAX_CHARS,
  MEMORY_SNAPSHOT_GLOBAL_CORE_MAX_ENTRIES, MEMORY_SNAPSHOT_PROJECT_CORE_MAX_ENTRIES
} from '../memoryConfig'

const KINDS: readonly MemoryKind[] = ['preference', 'convention', 'gotcha', 'workflow', 'decision', 'project_fact']
const USER_CORE = new Set<MemoryKind>(['preference', 'convention', 'workflow', 'gotcha'])
const VERIFIED_CORE = new Set<MemoryKind>(['convention', 'gotcha'])
export const escapeMemorySnapshotText = (text: string): string => text.replace(/[\r\n]+/g, ' ').replace(/<(\/?memory)/gi, '&lt;$1')
export const memoryCoreLine = (entry: StoredMemoryEntry): string => `- ${escapeMemorySnapshotText(entry.record.content)}`

export function selectCoreEntries(entries: readonly StoredMemoryEntry[], scopeKind: ScopeKind): { selected: StoredMemoryEntry[]; omitted: number } {
  const candidates = entries.filter(entry => entry.record.scopeKind === scopeKind && entry.location === 'topics' && entry.record.status === 'active' && (
    entry.pinned || entry.record.explicitness === 'user_explicit' && USER_CORE.has(entry.record.kind) ||
    entry.record.explicitness === 'workspace_verified' && VERIFIED_CORE.has(entry.record.kind) && entry.record.distinctSessionCount >= 2
  )).sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
    explicitnessRank(a) - explicitnessRank(b) || KINDS.indexOf(a.record.kind) - KINDS.indexOf(b.record.kind) ||
    b.record.lastSeenAt - a.record.lastSeenAt || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0))
  const maxChars = scopeKind === 'global' ? MEMORY_SNAPSHOT_GLOBAL_CORE_MAX_CHARS : MEMORY_SNAPSHOT_PROJECT_CORE_MAX_CHARS
  const maxEntries = scopeKind === 'global' ? MEMORY_SNAPSHOT_GLOBAL_CORE_MAX_ENTRIES : MEMORY_SNAPSHOT_PROJECT_CORE_MAX_ENTRIES
  const selected: StoredMemoryEntry[] = []
  let chars = 0
  for (const entry of candidates) {
    const length = memoryCoreLine(entry).length + 1
    if (selected.length < maxEntries && chars + length <= maxChars) { selected.push(entry); chars += length }
  }
  return { selected, omitted: candidates.length - selected.length }
}

function explicitnessRank(entry: StoredMemoryEntry): number {
  return ['user_explicit', 'workspace_verified', 'observed', 'inferred'].indexOf(entry.record.explicitness)
}
