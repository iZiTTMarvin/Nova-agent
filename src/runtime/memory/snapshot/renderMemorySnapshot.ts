import type { StoredMemoryEntry } from '../markdown/MemoryEntryStore'
import { MEMORY_TOPIC_FILES, localMemoryDate } from '../markdown/entryFormat'
import type { ScopeKind } from '../types'
import {
  MEMORY_SNAPSHOT_INDEX_KEYS_PER_FILE, MEMORY_SNAPSHOT_INDEX_MAX_CHARS,
  MEMORY_SNAPSHOT_MAX_CHARS, MEMORY_SNAPSHOT_WRAPPER
} from '../memoryConfig'
import { escapeMemorySnapshotText, memoryCoreLine, selectCoreEntries } from './selectCoreEntries'

export interface MemorySnapshotDocument { relPath: string; description: string }
export interface MemorySnapshotScope {
  scopeKind: ScopeKind
  entries: readonly StoredMemoryEntry[]
  documents: readonly MemorySnapshotDocument[]
  projectName?: string
  workspaceRoot?: string
}
export interface RenderedMemorySnapshot {
  text: string | null
  body: string
  globalCoreCount: number
  projectCoreCount: number
  omittedCoreCount: number
  omittedFileCount: number
  budgetOverflow: boolean
}

export function renderMemorySnapshot(input: { capturedAt: number; global?: MemorySnapshotScope; project?: MemorySnapshotScope }): RenderedMemorySnapshot {
  const global = selectCoreEntries(input.global?.entries ?? [], 'global')
  const project = selectCoreEntries(input.project?.entries ?? [], 'project')
  const candidates = [...fileIndex(input.project), ...fileIndex(input.global)].sort((a, b) =>
    a.order - b.order || compareText(a.path, b.path))
  const index: string[] = []
  let indexChars = 0
  let omittedFileCount = 0
  for (const file of candidates) {
    if (indexChars + file.line.length + 1 <= MEMORY_SNAPSHOT_INDEX_MAX_CHARS) {
      index.push(file.line); indexChars += file.line.length + 1
    } else omittedFileCount++
  }
  const indexSuffix = (): string => omittedFileCount ? `\n(${omittedFileCount} more files; use memory_search)` : ''
  while (index.length && indexChars + '## Files\n'.length + indexSuffix().length > MEMORY_SNAPSHOT_INDEX_MAX_CHARS) {
    indexChars -= index.pop()!.length + 1; omittedFileCount++
  }
  let budgetOverflow = false
  const body = (): string => {
    const sections: string[] = []
    if (global.selected.length) sections.push('## Global\n' + global.selected.map(memoryCoreLine).join('\n'))
    if (project.selected.length) {
      const projectInfo = input.project!
      const title = escapeMemorySnapshotText(projectInfo.projectName ?? 'Project')
      const workspace = projectInfo.workspaceRoot ? '\nWorkspace: ' + escapeMemorySnapshotText(projectInfo.workspaceRoot) : ''
      sections.push(`## Project: ${title}${workspace}\n${project.selected.map(memoryCoreLine).join('\n')}`)
    }
    if (index.length || omittedFileCount) sections.push('## Files\n' + index.join('\n') + indexSuffix())
    const omitted = global.omitted + project.omitted
    if (omitted) sections.push(`(${omitted} more core entries not shown; use memory_search)`)
    return sections.join('\n')
  }
  const wrap = (content: string): string => `${MEMORY_SNAPSHOT_WRAPPER}\n<memory captured="${localMemoryDate(input.capturedAt)}">\n${content}\n</memory>`
  while (wrap(body()).length > MEMORY_SNAPSHOT_MAX_CHARS) {
    budgetOverflow = true
    if (project.selected.length) { project.selected.pop(); project.omitted++ }
    else if (index.length) { index.pop(); omittedFileCount++ }
    else if (global.selected.length) { global.selected.pop(); global.omitted++ }
    else break
  }
  const content = body()
  return { text: content ? wrap(content) : null, body: content,
    globalCoreCount: global.selected.length, projectCoreCount: project.selected.length,
    omittedCoreCount: global.omitted + project.omitted, omittedFileCount, budgetOverflow }
}

function fileIndex(scope?: MemorySnapshotScope): { line: string; order: number; path: string }[] {
  if (!scope) return []
  const result: { line: string; order: number; path: string }[] = []
  const files = new Map<string, StoredMemoryEntry[]>()
  for (const entry of scope.entries) {
    if (entry.location !== 'topics' || entry.record.scopeKind !== scope.scopeKind) continue
    const entries = files.get(entry.relPath) ?? []
    entries.push(entry); files.set(entry.relPath, entries)
  }
  for (const [relPath, entries] of files) {
    const frequencies = new Map<string, number>()
    for (const entry of entries) for (const key of [entry.record.memoryKey, ...entry.aliases]) {
      if (key) frequencies.set(key, (frequencies.get(key) ?? 0) + 1)
    }
    const keys = [...frequencies].sort(([a, x], [b, y]) => y - x || compareText(a, b))
      .slice(0, MEMORY_SNAPSHOT_INDEX_KEYS_PER_FILE).map(([key]) => escapeMemorySnapshotText(key))
    const path = `${scope.scopeKind}/${relPath}`
    result.push({ line: `- ${escapeMemorySnapshotText(path)} · ${entries.length} entries · keys: ${keys.join(', ')}`, order: 0, path })
  }
  for (const file of scope.documents) {
    if (file.relPath === 'MEMORY.md' || file.relPath === 'inbox.md' || file.relPath === 'archive.md' || file.relPath.startsWith('.') || file.relPath.startsWith('episodic/')) continue
    if (Object.values(MEMORY_TOPIC_FILES).includes(file.relPath)) continue
    const path = `${scope.scopeKind}/${file.relPath}`
    result.push({ line: `- ${escapeMemorySnapshotText(path)} · ${escapeMemorySnapshotText(file.description).slice(0, 60)}`,
      order: file.relPath === 'notes.md' ? 1 : 2, path })
  }
  return result
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
