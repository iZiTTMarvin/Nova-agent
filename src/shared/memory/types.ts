export type MemoryScopeKindDto = 'project' | 'global'
export type MemoryKindDto = 'preference' | 'convention' | 'project_fact' | 'decision' | 'workflow' | 'gotcha'
export type MemoryExplicitnessDto = 'user_explicit' | 'workspace_verified' | 'observed' | 'inferred'
export type MemoryEntryLocationDto = 'topics' | 'inbox' | 'archive'
export interface MemoryScopeFileEntry { relPath: string; size: number; mtimeMs: number }
export interface MemoryFileDto extends MemoryScopeFileEntry { managed: boolean; readOnly: boolean; parseIssues: number; needsOrganization: boolean }
export interface MemoryDocumentStats { scopeId: string; scopeDir: string; fileCount: number; indexCount: number; diskBytes: number }
export interface MemoryScopeStats extends MemoryDocumentStats {
  entries: Record<MemoryEntryLocationDto, number>
  indexStatus: 'ok' | 'dirty' | 'unavailable'
  diagnostic: string | null
  ledgerBadLines: number
  readOnly: boolean
}
export interface ReconcileStats { added: number; updated: number; removed: number; skipped: number }
export interface MemoryScopeParams { scopeKind: MemoryScopeKindDto; scopeId?: string }
export interface MemoryReadFileParams extends MemoryScopeParams { relPath: string }
export interface MemoryWriteFileParams extends MemoryReadFileParams { content: string }
export interface MemoryListEntriesParams extends MemoryScopeParams { location?: MemoryEntryLocationDto }
export interface MemoryEntryParams extends MemoryScopeParams { id: string }
export interface MemorySetEntryPinnedParams extends MemoryEntryParams { pinned: boolean }
export interface MemoryDecideInboxParams extends MemoryEntryParams { decision: 'approve' | 'reject' }
export interface MemoryEntryDto {
  id: string
  scopeKind: MemoryScopeKindDto
  kind: MemoryKindDto
  location: MemoryEntryLocationDto
  relPath: string
  text: string
  key: string | null
  aliases: string[]
  explicitness: MemoryExplicitnessDto
  pinned: boolean
  needsVerification: boolean
  addedDate: string
  lastSeenAt: number
  evidenceCount: number
}
export interface MemorySnapshotPreview { text: string | null; globalCoreCount: number; projectCoreCount: number; omittedCoreCount: number }
export interface MemoryOrganizationResult { merged: number; retired: number }
export interface MemoryLegacyDto { oldHash: string; fileCount: number; diskBytes: number }
export interface MemorySnapshotSummary { capturedAt: number; globalCoreCount: number; projectCoreCount: number; omittedCoreCount: number }
