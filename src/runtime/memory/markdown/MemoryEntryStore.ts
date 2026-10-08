import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { GLOBAL_SCOPE_ID, MemoryScopeDirectoryResolver, parseScopeIdFromDirName } from '../MemoryPaths'
import type { MemoryEvidenceDraft, MemoryEvidenceMergeInput, MemoryRecordDraft, MemoryStatusUpdateOptions } from '../repository/MemoryRepository'
import type { Explicitness, ForgottenMemory, MemoryEvidence, MemoryKind, MemoryRecord, MemoryScope, MemoryStatus } from '../types'
import { buildQueryTerms, type LexicalHit } from '../index/indexTerms'
import { MEMORY_ALIAS_MAX_COUNT, MEMORY_BACKUP_KEEP, MEMORY_TOPIC_SOFT_MAX_BYTES, MEMORY_TOPIC_SOFT_MAX_ENTRIES } from '../memoryConfig'
import { selectExpiredMemoryIds, validateMemoryMaintenancePlan } from '../maintenance/maintenanceRules'
import { scanScopeMarkdownFiles } from '../MemoryReconciler'
import { renderMemorySnapshot, type MemorySnapshotScope } from '../snapshot/renderMemorySnapshot'
import {
  generateMemoryEntryId, localMemoryDate, MEMORY_FILE_HEADER, MEMORY_GENERATED_HEADER,
  MEMORY_TOPIC_FILES, MEMORY_TOPIC_TITLES, escapeMemoryText, parseMemoryFile, serializeMemoryEntryLine, serializeMemoryFile,
  type MemoryEntryBy, type MemoryFileEntry, type MemoryFileLine, type MemoryFileModel
} from './entryFormat'
import {
  MemoryLedger, parseMemoryLedger, reduceMemoryLedger,
  type MemoryEntryVia, type MemoryLedgerEvent, type MemoryLedgerAppendFile
} from './MemoryLedger'
import { assertMemoryFilePath, inspectMemoryFilePaths, cleanStaleMemoryTemps, memoryFileFingerprint, MemoryFileConflictError, writeFileAtomic, type AtomicMemoryFileOptions } from './atomicFile'

export type MemoryEntryLocation = 'topics' | 'inbox' | 'archive'
export interface StoredMemoryEntry {
  record: MemoryRecord
  relPath: string
  location: MemoryEntryLocation
  aliases: string[]
  pinned: boolean
  addedDate: string
  via: MemoryEntryVia
}
export interface MemoryEntryStoreOptions {
  now?: () => number
  generateId?: () => string
  writeFile?: (path: string, content: string | Uint8Array, options: AtomicMemoryFileOptions) => void
  appendLedgerFile?: MemoryLedgerAppendFile
  onIndexChanged?: (scope: MemoryScope, entries: readonly StoredMemoryEntry[]) => void
  readPreviousEntries?: (scope: MemoryScope) => readonly Pick<MemoryRecord, 'id' | 'content'>[]
  onError?: (stage: 'index' | 'view', error: unknown) => void
}
export interface MemoryEntryInsert extends MemoryRecordDraft {
  aliases?: readonly string[]
  pinned?: boolean
  via?: MemoryEntryVia
}
interface ScopeFile {
  model: MemoryFileModel
  /** structuredClone 会把 Buffer 降为普通 Uint8Array，编码前须先 Buffer.from。 */
  original: Uint8Array | null
  fingerprint: string | null
  mtime: number
}
interface ScopeState {
  scope: MemoryScope
  dir: string
  files: Map<string, ScopeFile>
  ledgerText: string
  ledgerFingerprint: string | null
}

const BY_TO_EXPLICIT: Readonly<Record<MemoryEntryBy, Explicitness>> = {
  user: 'user_explicit', verified: 'workspace_verified', observed: 'observed', inferred: 'inferred'
}
const EXPLICIT_TO_BY: Readonly<Record<Explicitness, MemoryEntryBy>> = {
  user_explicit: 'user', workspace_verified: 'verified', observed: 'observed', inferred: 'inferred'
}
const clone = <T>(value: T): T => structuredClone(value)
const encodeBackupBytes = (bytes: Uint8Array | null): string | null => bytes ? Buffer.from(bytes).toString('base64') : null

function managedFiles(scope: MemoryScope): string[] {
  const topics = Object.entries(MEMORY_TOPIC_FILES)
    .filter(([kind]) => scope.scopeKind === 'project' || kind !== 'project_fact')
    .map(([, path]) => path)
  return [...topics, 'inbox.md', 'archive.md']
}

function kindForFile(path: string): MemoryKind | undefined {
  return (Object.entries(MEMORY_TOPIC_FILES) as [MemoryKind, string][]).find(([, name]) => name === path)?.[0]
}

/** 坏行只按行尾元数据注释里的 id 归属条目，正文里提到同一 id 的用户文字不算该条目。 */
function memoryLineBelongsToIds(raw: string, ids: Set<string>): boolean {
  const match = raw.match(/  <!-- (?:.* )?id=([^\s>]+)(?: .*)? -->\s*$/)
  return match !== null && ids.has(match[1])
}

function fileLocation(path: string): MemoryEntryLocation {
  return path === 'inbox.md' ? 'inbox' : path === 'archive.md' ? 'archive' : 'topics'
}

export class MemoryEntryStore {
  private readonly scopes = new Map<string, ScopeState>()
  private readonly projections = new WeakMap<ScopeState, { entries: StoredMemoryEntry[]; byId: Map<string, StoredMemoryEntry> }>()
  private readonly directories: MemoryScopeDirectoryResolver
  private readonly now: () => number
  private readonly generateId: () => string
  private readonly writeFile: NonNullable<MemoryEntryStoreOptions['writeFile']>
  private readOnly = false

  setReadOnly(value: boolean): void { this.readOnly = value }
  isReadOnly(): boolean { return this.readOnly }

  importEntry(scope: MemoryScope, entry: MemoryFileEntry, kind: MemoryKind, status: MemoryStatus, events: readonly MemoryLedgerEvent[]): void {
    if (!entry.metadata.id) throw new Error('Imported memory requires an ID')
    if (events.some(event => event.id !== entry.metadata.id)) throw new Error('Imported provenance belongs to another memory')
    const parsed = parseMemoryFile(`${MEMORY_FILE_HEADER}\n${serializeMemoryEntryLine(entry)}\n`)
    if (parsed.issues || !parsed.lines.some(line => line.type === 'entry')) throw new Error('Invalid imported memory entry')
    if (scope.scopeKind === 'global' && kind === 'project_fact') throw new Error('Invalid global memory kind')
    this.mutate(scope, state => {
      const existing = this.locate(state, entry.metadata.id!)
      if (existing && existing[2].text !== entry.text) throw new Error('Imported memory ID conflicts with existing content')
      if (!existing) {
        const copy = clone(entry)
        const until = copy.metadata.until
        const path = this.pathForStatus(copy, kind, status, this.now())
        if (until && path === 'archive.md') copy.metadata.until = until
        this.appendEntry(state, path, copy)
      } else {
        if (state.files.get(existing[0])!.model.readOnly) throw new Error('Memory file is read-only')
        const aliases = [...new Set([...(existing[2].metadata.aliases ?? []), ...(entry.metadata.aliases ?? [])])]
        if (aliases.length) existing[2].metadata.aliases = aliases.slice(0, MEMORY_ALIAS_MAX_COUNT)
        if (entry.metadata.pin === '1') existing[2].metadata.pin = '1'
      }
      const previous = new Set(parseMemoryLedger(state.ledgerText).events.map(event => JSON.stringify(event)))
      this.appendLedger(state, events.filter(event => !previous.has(JSON.stringify(event))))
    })
  }

  remapReplacementIds(scope: MemoryScope, replacements: ReadonlyMap<string, string>): void {
    this.mutate(scope, state => {
      for (const file of state.files.values()) {
        for (const line of file.model.lines) if (line.type === 'entry' && line.entry.metadata.by_id) {
          const id = replacements.get(line.entry.metadata.by_id)
          if (id && id !== line.entry.metadata.by_id) {
            if (file.model.readOnly) throw new Error('Memory file is read-only')
            line.entry.metadata.by_id = id
          }
        }
      }
    })
  }

  constructor(readonly memoryRoot: string, private readonly options: MemoryEntryStoreOptions = {}) {
    this.directories = new MemoryScopeDirectoryResolver(memoryRoot)
    this.now = options.now ?? Date.now
    this.generateId = options.generateId ?? generateMemoryEntryId
    this.writeFile = options.writeFile ?? writeFileAtomic
  }

  registerWorkspace(workspaceRoot: string): string {
    return this.directories.registerWorkspace(workspaceRoot)
  }

  listScopes(): MemoryScope[] {
    const scopes: MemoryScope[] = [{ scopeKind: 'global', scopeId: GLOBAL_SCOPE_ID }]
    const projects = join(this.memoryRoot, 'projects')
    if (existsSync(projects)) {
      for (const directory of readdirSync(projects, { withFileTypes: true })) {
        if (!directory.isDirectory() || directory.isSymbolicLink()) continue
        const scopeId = parseScopeIdFromDirName(directory.name)
        if (scopeId && !scopes.some(scope => scope.scopeId === scopeId)) scopes.push({ scopeKind: 'project', scopeId })
      }
    }
    return scopes
  }

  list(scope: MemoryScope, location?: MemoryEntryLocation): StoredMemoryEntry[] {
    const entries = this.entries(this.load(scope))
    return clone(location ? entries.filter(entry => entry.location === location) : entries)
  }

  find(id: string, scope?: MemoryScope): StoredMemoryEntry | null {
    for (const candidate of scope ? [scope] : this.listScopes()) {
      const state = this.load(candidate)
      this.entries(state)
      const found = this.projections.get(state)?.byId.get(id)
      if (found) return clone(found)
    }
    return null
  }

  findByIds(scope: MemoryScope, ids: readonly string[]): StoredMemoryEntry[] {
    const state = this.load(scope)
    this.entries(state)
    const byId = this.projections.get(state)!.byId
    return clone(ids.flatMap(id => { const entry = byId.get(id); return entry ? [entry] : [] }))
  }

  listEvidence(scope: MemoryScope, id: string): MemoryEvidence[] {
    return parseMemoryLedger(this.load(scope).ledgerText).events.flatMap((event, index) => event.op === 'evidence' && event.id === id ? [{
      id: `${id}:${index}`, memoryId: id, sessionId: event.session ?? null, messageId: event.message ?? null,
      projectScopeId: event.project ?? null, evidenceType: event.type, excerpt: event.excerpt ?? null, createdAt: event.at
    }] : [])
  }

  scan(scope: MemoryScope, query: string, limit = 30, history = false): LexicalHit[] {
    const terms = buildQueryTerms(query)
    const hits = this.entries(this.load(scope)).filter(entry => history ? entry.record.status !== 'pending' : entry.record.status === 'active').map(entry => {
      const text = `${entry.record.content} ${entry.aliases.join(' ')} ${entry.record.memoryKey ?? ''}`.normalize('NFKC').toLowerCase()
      return { id: entry.record.id, score: terms.filter(term => text.includes(term)).length }
    }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit)
    const top = hits[0]?.score ?? 1
    return hits.map(hit => ({ ...hit, score: hit.score / top }))
  }

  stats(scope: MemoryScope): { parseIssues: number; ledgerBadLines: number } {
    const state = this.load(scope)
    return {
      parseIssues: [...state.files.values()].reduce((sum, file) => sum + file.model.issues, 0),
      ledgerBadLines: parseMemoryLedger(state.ledgerText).badLines
    }
  }

  reconcile(scope: MemoryScope): StoredMemoryEntry[] {
    return this.list(scope)
  }

  writeManagedFile(scope: MemoryScope, relPath: string, content: string): number {
    if (!managedFiles(scope).includes(relPath)) throw new Error('Not a managed memory file')
    const model = parseMemoryFile(content)
    if (model.readOnly) throw new Error('Unsupported memory format')
    let issues = 0
    this.mutate(scope, state => {
      const previous = clone(state)
      const existing = state.files.get(relPath)
      if (existing?.model.readOnly) throw new Error('Memory file is read-only')
      state.files.set(relPath, { model: clone(model), original: existing?.original ?? null,
        fingerprint: existing?.fingerprint ?? null, mtime: existing?.mtime ?? this.now() })
      this.synchronize(state, previous)
      issues = state.files.get(relPath)!.model.issues
    })
    return issues
  }

  snapshotScope(scope: MemoryScope): MemorySnapshotScope {
    const state = this.load(scope)
    return this.snapshotData(state, clone(this.entries(state)))
  }

  private snapshotData(state: ScopeState, entries: readonly StoredMemoryEntry[]): MemorySnapshotScope {
    const workspaceRoot = this.directories.getWorkspaceRoot(state.scope.scopeId)
    return { scopeKind: state.scope.scopeKind, entries, workspaceRoot,
      projectName: workspaceRoot ? basename(workspaceRoot) : basename(state.dir).replace(/-[0-9a-f]{16}$/, ''),
      documents: scanScopeMarkdownFiles(state.dir, state.scope.scopeKind).map(file => ({ relPath: file.relPath,
        description: (file.body.split(/\r?\n/).find(line => /^\s*#+\s+\S/.test(line)) ?? file.body.split(/\r?\n/).find(line => line.trim()) ?? '').replace(/^\s*#+\s*/, '').slice(0, 60) })) }
  }

  insert(draft: MemoryEntryInsert): MemoryRecord {
    if (draft.scope.scopeKind === 'global' && draft.kind === 'project_fact') throw new Error('Global memory cannot contain project facts')
    const at = this.now()
    this.mutate(draft.scope, state => {
      if (this.entries(state).some(entry => entry.record.id === draft.id)) throw new Error('Duplicate memory ID')
      const entry: MemoryFileEntry = {
        text: draft.content,
        metadata: {
          id: draft.id, by: EXPLICIT_TO_BY[draft.explicitness], added: localMemoryDate(at),
          key: draft.memoryKey ?? undefined, aliases: draft.aliases ? [...draft.aliases] : undefined,
          pin: draft.pinned ? '1' : undefined, src: draft.sourcePath ?? undefined,
          fp: draft.sourceFingerprint ?? undefined, unknown: {}
        }
      }
      const path = this.pathForStatus(entry, draft.kind, draft.status, draft.validTo ?? at)
      this.appendEntry(state, path, entry)
      this.appendLedger(state, [
        { v: 1, op: 'create', id: draft.id, at, conf: draft.confidence, source: draft.sourceType, via: draft.via ?? 'tool' },
        ...this.evidenceEvents(draft.id, draft.evidence ?? [], at)
      ])
    })
    return this.find(draft.id, draft.scope)!.record
  }

  mergeEvidence(scope: MemoryScope, id: string, input: MemoryEvidenceMergeInput): boolean {
    return this.mutateEntry(scope, id, (state, entry) => {
      const at = input.lastSeenAt ?? this.now()
      entry.metadata.seen = localMemoryDate(at)
      delete entry.metadata.verify
      if (input.sourceBinding === null) { delete entry.metadata.src; delete entry.metadata.fp }
      else if (input.sourceBinding) { entry.metadata.src = input.sourceBinding.path; entry.metadata.fp = input.sourceBinding.fingerprint }
      const record = this.entries(state).find(item => item.record.id === id)!.record
      this.appendLedger(state, [
        ...this.evidenceEvents(id, input.evidence, at),
        { v: 1, op: 'touch', id, at, conf: input.confidence ?? record.confidence }
      ])
    })
  }

  updateStatus(scope: MemoryScope, id: string, status: MemoryStatus, options: MemoryStatusUpdateOptions = {}): boolean {
    return this.mutateEntry(scope, id, (state, entry, path, index) => {
      const kind = kindForFile(path) ?? entry.metadata.kind
      if (!kind) throw new Error('Missing memory kind')
      const destination = this.pathForStatus(entry, kind, status, options.validTo ?? this.now())
      if (destination !== path) {
        state.files.get(path)!.model.lines.splice(index, 1)
        this.appendEntry(state, destination, entry)
      }
      this.appendLedger(state, [{ v: 1, op: 'touch', id, at: this.now(), conf: this.confidence(state, id) }])
    })
  }

  supersede(scope: MemoryScope, oldId: string, draft: MemoryEntryInsert): MemoryRecord {
    const at = this.now()
    this.mutate(scope, state => {
      const found = this.locate(state, oldId)
      if (!found) throw new Error('Memory entry not found')
      if (found[0] === 'archive.md') throw new Error('Cannot supersede archived memory')
      if (this.locate(state, draft.id)) throw new Error('Duplicate memory ID')
      if (draft.scope.scopeId !== scope.scopeId || draft.scope.scopeKind !== scope.scopeKind) throw new Error('Cannot supersede across scopes')
      const [path, index, oldEntry] = found
      const kind = kindForFile(path) ?? oldEntry.metadata.kind
      if (!kind || draft.kind !== kind) throw new Error('Cannot supersede across kinds')
      this.pathForStatus(oldEntry, kind, 'superseded', at)
      oldEntry.metadata.by_id = draft.id
      this.appendEntry(state, 'archive.md', oldEntry)
      const newEntry: MemoryFileEntry = {
        text: draft.content,
        metadata: { id: draft.id, by: EXPLICIT_TO_BY[draft.explicitness], added: localMemoryDate(at),
          key: draft.memoryKey ?? undefined, aliases: draft.aliases ? [...draft.aliases] : undefined,
          src: draft.sourcePath ?? undefined, fp: draft.sourceFingerprint ?? undefined, unknown: {} }
      }
      const destination = this.pathForStatus(newEntry, draft.kind, draft.status, at)
      if (destination === path) state.files.get(path)!.model.lines[index] = this.entryLine(newEntry, state.files.get(path)!.model.newline)
      else { state.files.get(path)!.model.lines.splice(index, 1); this.appendEntry(state, destination, newEntry) }
      this.appendLedger(state, [
        { v: 1, op: 'create', id: draft.id, at, conf: draft.confidence, source: draft.sourceType, via: draft.via ?? 'tool' },
        ...this.evidenceEvents(draft.id, draft.evidence ?? [], at)
      ])
    })
    return this.find(draft.id, scope)!.record
  }

  /**
   * 收集彻底遗忘的闭包（只读）：目标 id 加上本 scope 内 by_id 链指向集合内 id 的条目
   * （被它取代/合并的旧版本一并遗忘），迭代到不动点。
   * 条目或带元数据的坏行均不存在时返回 null，调用方不应触碰任何派生副本。
   */
  collectForgetTargets(scope: MemoryScope, id: string): ForgottenMemory | null {
    const state = this.load(scope)
    const ids = new Set<string>([id])
    for (let expanded = true; expanded;) {
      expanded = false
      for (const file of state.files.values()) {
        for (const line of file.model.lines) {
          const metadata = line.type === 'entry' ? line.entry.metadata : null
          if (metadata?.id && metadata.by_id && ids.has(metadata.by_id) && !ids.has(metadata.id)) {
            ids.add(metadata.id)
            expanded = true
          }
        }
      }
    }
    const exists = [...state.files.values()].some(file => file.model.lines.some(line =>
      line.type === 'entry' ? !!line.entry.metadata.id && ids.has(line.entry.metadata.id)
        : line.type === 'invalid' && memoryLineBelongsToIds(line.raw, ids)))
    if (!exists) return null
    const contents = new Set<string>()
    for (const file of state.files.values()) {
      for (const line of file.model.lines) {
        if (line.type === 'entry' && line.entry.metadata.id && ids.has(line.entry.metadata.id)) contents.add(line.entry.text)
      }
    }
    return { scope, ids: [...ids], contents: [...contents] }
  }

  purge(scope: MemoryScope, id: string): boolean {
    const forgotten = this.collectForgetTargets(scope, id)
    if (!forgotten) return false
    const ids = new Set(forgotten.ids)
    // 先清整理备份里的副本，再删事实源；任一步失败都保留可重试的现场。
    this.redactScopeBackups(scope, forgotten)
    let found = false
    this.mutate(scope, state => {
      for (const file of state.files.values()) {
        const before = file.model.lines.length
        const matches = (line: MemoryFileLine): boolean => line.type === 'entry'
          ? !!line.entry.metadata.id && ids.has(line.entry.metadata.id)
          : line.type === 'invalid' && memoryLineBelongsToIds(line.raw, ids)
        if (file.model.readOnly && file.model.lines.some(matches)) throw new Error('Memory file is read-only')
        file.model.lines = file.model.lines.filter(line => !matches(line))
        found ||= before !== file.model.lines.length
      }
      state.ledgerText = this.filterLedger(state.ledgerText, ids)
    })
    return found
  }

  /**
   * 清理本 scope 的 .backups/memory-*.json 中被遗忘条目：
   * .md 按行结构删除，.ledger.jsonl 按 id 行过滤；清理后解码字节仍含任一被遗忘正文、
   * 或备份不是合法 version 1 时整份删除（fail closed）。有变化才原子重写。
   */
  private redactScopeBackups(scope: MemoryScope, forgotten: ForgottenMemory): void {
    const directory = join(this.directories.resolve(scope.scopeId), '.backups')
    if (!existsSync(directory)) return
    assertMemoryFilePath(join(directory, 'probe.json'), this.memoryRoot)
    const ids = new Set(forgotten.ids)
    const contents = forgotten.contents.flatMap(content => [content, escapeMemoryText(content)])
    const retainsForgotten = (bytes: Buffer): boolean =>
      contents.some(content => bytes.toString('utf8').includes(content))
    for (const name of readdirSync(directory)) {
      if (!/^memory-\d{16}-m_[a-z0-9]{10}\.json$/.test(name)) continue
      const path = join(directory, name)
      assertMemoryFilePath(path, this.memoryRoot)
      const raw = readFileSync(path, 'utf8')
      let parsed: { files?: unknown } | null = null
      try {
        const value: unknown = JSON.parse(raw)
        if (value && typeof value === 'object' && !Array.isArray(value)
          && (value as { version?: unknown }).version === 1
          && (value as { files?: unknown }).files && typeof (value as { files?: unknown }).files === 'object') {
          parsed = value as { files?: unknown }
        }
      } catch { /* 不是合法 version 1：下方按 fail closed 删除 */ }
      if (!parsed) {
        unlinkSync(path)
        continue
      }
      const files = parsed.files as Record<string, string | null>
      let remove = false
      for (const [relPath, encoded] of Object.entries(files)) {
        if (encoded === null) continue
        let bytes = Buffer.from(encoded, 'base64')
        let next: Buffer = bytes
        if (relPath === '.ledger.jsonl') {
          const filtered = this.filterLedger(bytes.toString('utf8'), ids)
          if (filtered !== bytes.toString('utf8')) next = Buffer.from(filtered, 'utf8')
        } else if (relPath.endsWith('.md')) {
          const model = parseMemoryFile(bytes)
          const kept = model.lines.filter(line => line.type === 'entry'
            ? !line.entry.metadata.id || !ids.has(line.entry.metadata.id)
            : line.type !== 'invalid' || !memoryLineBelongsToIds(line.raw, ids))
          if (kept.length !== model.lines.length) {
            model.lines = kept
            try { next = Buffer.from(serializeMemoryFile(model), 'utf8') } catch { remove = true }
          }
        }
        // 正文可能残留在文本行、非托管文件或序列化失败的结果里，命中即整份删除
        if (retainsForgotten(next)) remove = true
        if (next !== bytes) files[relPath] = next.toString('base64')
      }
      if (remove) {
        unlinkSync(path)
        continue
      }
      const output = JSON.stringify({ version: 1, files })
      if (output !== raw) {
        this.writeFile(path, output, { memoryRoot: this.memoryRoot, expectedFingerprint: memoryFileFingerprint(path) })
      }
    }
  }

  setPinned(scope: MemoryScope, id: string, pinned: boolean): boolean {
    return this.mutateEntry(scope, id, (_state, entry) => {
      if (pinned) entry.metadata.pin = '1'
      else delete entry.metadata.pin
    })
  }

  approve(scope: MemoryScope, id: string): boolean {
    return this.mutateEntry(scope, id, (state, entry, path, index) => {
      if (path !== 'inbox.md' || !entry.metadata.kind) throw new Error('Entry is not in the inbox')
      const kind = entry.metadata.kind
      entry.metadata.by = 'user'
      const destination = this.pathForStatus(entry, kind, 'active', this.now())
      state.files.get(path)!.model.lines.splice(index, 1)
      this.appendEntry(state, destination, entry)
      this.appendLedger(state, [{ v: 1, op: 'touch', id, at: this.now(), conf: 1 }])
    })
  }

  maintain(scope: MemoryScope, clearLearned = false): number {
    let removed = 0
    this.mutate(scope, state => {
      if ([...state.files.values()].some(file => file.model.readOnly)) throw new Error('Memory scope is read-only')
      const ids = selectExpiredMemoryIds(this.entries(state), this.now(), clearLearned)
      removed = ids.size
      for (const file of state.files.values()) file.model.lines = file.model.lines.filter(line => line.type !== 'entry' || !line.entry.metadata.id || !ids.has(line.entry.metadata.id))
      state.ledgerText = this.filterLedger(state.ledgerText, ids)
      this.synchronize(state)
    })
    return removed
  }

  topicMaintenanceInput(scope: MemoryScope, relPath: string): { entries: StoredMemoryEntry[]; fingerprint: string | null; suggested: boolean } {
    if (!kindForFile(relPath)) throw new Error('Only topic files can be organized')
    const state = this.load(scope), file = state.files.get(relPath)
    if (file?.model.readOnly || this.readOnly) throw new Error('Memory file is read-only')
    const entries = clone(this.entries(state).filter(entry => entry.relPath === relPath && entry.record.status === 'active'))
    return { entries, fingerprint: file?.fingerprint ?? null, suggested: entries.length > MEMORY_TOPIC_SOFT_MAX_ENTRIES || (file?.original?.byteLength ?? 0) > MEMORY_TOPIC_SOFT_MAX_BYTES }
  }

  organize(scope: MemoryScope, relPath: string, rawPlan: unknown, expectedFingerprint: string | null): void {
    if (!kindForFile(relPath)) throw new Error('Only topic files can be organized')
    const topicPath = join(this.directories.resolve(scope.scopeId), relPath)
    assertMemoryFilePath(topicPath, this.memoryRoot)
    if (memoryFileFingerprint(topicPath) !== expectedFingerprint) throw new MemoryFileConflictError(topicPath)
    let backupPath: string | undefined
    let backupFingerprint: string | null = null
    try {
      this.mutate(scope, state => {
        const file = state.files.get(relPath)
        if (!file || file.model.readOnly || state.files.get('archive.md')?.model.readOnly) throw new Error('Memory file is read-only')
        if (file.fingerprint !== expectedFingerprint) throw new MemoryFileConflictError(join(state.dir, relPath))
        const entries = this.entries(state).filter(entry => entry.relPath === relPath && entry.record.status === 'active')
        const plan = validateMemoryMaintenancePlan(rawPlan, entries)
        if (!plan.merge.length && !plan.retire.length) return
        const at = this.now()
        const ids = new Set(this.entries(state).map(entry => entry.record.id))
        const ledger = parseMemoryLedger(state.ledgerText).events
        const groups = plan.merge.map(group => {
          const members = entries.filter(entry => group.ids.includes(entry.record.id))
          const first = members[0]
          const byOrder: Readonly<Record<Explicitness, number>> = { user_explicit: 0, workspace_verified: 1, observed: 2, inferred: 3 }
          const strongest = [...members].sort((a, b) => byOrder[a.record.explicitness] - byOrder[b.record.explicitness])[0]
          const id = this.uniqueId(ids); ids.add(id)
          const entry: MemoryFileEntry = { text: group.content, metadata: { id, by: EXPLICIT_TO_BY[strongest.record.explicitness], added: localMemoryDate(at), key: group.key ?? undefined, aliases: group.aliases,
            pin: members.some(member => member.pinned) ? '1' : undefined, unknown: {} } }
          return { group, members, first, strongest, id, entry }
        })
        const replacements = new Map(groups.flatMap(group => group.group.ids.map(id => [id, group] as const)))
        const retire = new Set(plan.retire)
        const lines: MemoryFileLine[] = []
        for (const line of file.model.lines) {
          if (line.type !== 'entry' || !line.entry.metadata.id) { lines.push(line); continue }
          const id = line.entry.metadata.id, group = replacements.get(id)
          if (group) {
            const archived = clone(line.entry)
            this.pathForStatus(archived, kindForFile(relPath)!, 'superseded', at)
            archived.metadata.by_id = group.id
            this.appendEntry(state, 'archive.md', archived)
            if (id === group.first.record.id) lines.push(this.entryLine(group.entry, file.model.newline))
          } else if (retire.has(id)) {
            const archived = clone(line.entry)
            this.pathForStatus(archived, kindForFile(relPath)!, 'retracted', at)
            this.appendEntry(state, 'archive.md', archived)
          } else lines.push(line)
        }
        file.model.lines = lines
        for (const group of groups) this.appendLedger(state, [
          { v: 1, op: 'create', id: group.id, at, conf: Math.max(...group.members.map(entry => entry.record.confidence)), source: group.strongest.record.sourceType, via: 'extract' },
          ...ledger.filter(event => event.op === 'evidence' && group.group.ids.includes(event.id)).map(event => ({ ...event, id: group.id }))
        ])
        const savedFiles = Object.fromEntries([relPath, 'archive.md'].map(path => [path, encodeBackupBytes(state.files.get(path)?.original ?? null)]))
        const ledgerPath = join(state.dir, '.ledger.jsonl')
        assertMemoryFilePath(ledgerPath, this.memoryRoot)
        savedFiles['.ledger.jsonl'] = state.ledgerFingerprint === null ? null : readFileSync(ledgerPath).toString('base64')
        backupPath ??= join(state.dir, '.backups', `memory-${String(at).padStart(16, '0')}-${generateMemoryEntryId()}.json`)
        this.writeFile(backupPath, JSON.stringify({ version: 1, files: savedFiles }), { memoryRoot: this.memoryRoot, expectedFingerprint: null })
        backupFingerprint = memoryFileFingerprint(backupPath)
      })
    } catch (error) {
      if (backupPath && existsSync(backupPath)) {
        assertMemoryFilePath(backupPath, this.memoryRoot)
        if (memoryFileFingerprint(backupPath) !== backupFingerprint) throw new AggregateError([error, new MemoryFileConflictError(backupPath)], 'Maintenance backup changed externally')
        unlinkSync(backupPath)
      }
      throw error
    }
    try { this.trimMaintenanceBackups(scope) } catch { console.warn('[MemoryEntryStore] backup retention deferred') }
  }

  trimMaintenanceBackups(scope: MemoryScope): void {
    const directory = join(this.directories.resolve(scope.scopeId), '.backups')
    if (!existsSync(directory)) return
    assertMemoryFilePath(join(directory, 'probe.json'), this.memoryRoot)
    const backups = readdirSync(directory).filter(name => /^memory-\d{16}-m_[a-z0-9]{10}\.json$/.test(name))
      .map(name => { const path = join(directory, name); assertMemoryFilePath(path, this.memoryRoot); return { path, mtime: lstatSync(path).mtimeMs } })
      .sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path))
    for (const backup of backups.slice(MEMORY_BACKUP_KEEP)) unlinkSync(backup.path)
  }

  private load(scope: MemoryScope): ScopeState {
    if (scope.scopeKind === 'global' && scope.scopeId !== GLOBAL_SCOPE_ID) throw new Error('Invalid global memory scope')
    if (scope.scopeKind === 'project' && scope.scopeId === GLOBAL_SCOPE_ID) throw new Error('Invalid project memory scope')
    const dir = this.directories.resolve(scope.scopeId)
    const previous = this.scopes.get(scope.scopeId)
    const files = new Map<string, ScopeFile>()
    let changed = previous?.dir !== dir
    const paths = managedFiles(scope)
    const ledgerPath = join(dir, '.ledger.jsonl')
    const fingerprints = inspectMemoryFilePaths([...paths.map(path => join(dir, path)), ledgerPath], this.memoryRoot)
    for (const path of paths) {
      const absolute = join(dir, path)
      const fingerprint = fingerprints.get(absolute) ?? null
      const cached = previous?.files.get(path)
      if (cached && cached.fingerprint === fingerprint && previous?.dir === dir) { files.set(path, cached); continue }
      changed ||= fingerprint !== null || cached?.fingerprint !== undefined
      if (fingerprint === null) continue
      const original = readFileSync(absolute)
      files.set(path, { model: parseMemoryFile(original), original, fingerprint, mtime: lstatSync(absolute).mtimeMs })
    }
    const ledgerFingerprint = fingerprints.get(ledgerPath) ?? null
    changed ||= previous?.ledgerFingerprint !== ledgerFingerprint
    if (!changed && previous) return previous
    const state: ScopeState = { scope: clone(scope), dir, files: clone(files),
      ledgerText: ledgerFingerprint === null ? '' : readFileSync(ledgerPath, 'utf8'), ledgerFingerprint }
    if (this.readOnly) { this.scopes.set(scope.scopeId, state); return state }
    this.synchronize(state, previous)
    this.commit(state)
    cleanStaleMemoryTemps(dir, this.memoryRoot, this.now())
    return this.scopes.get(scope.scopeId)!
  }

  private synchronize(state: ScopeState, previous?: ScopeState): void {
    let previousRecords: readonly Pick<MemoryRecord, 'id' | 'content'>[] = previous ? this.entries(previous).map(item => item.record) : []
    if (!previous && this.options.readPreviousEntries) {
      try { previousRecords = this.options.readPreviousEntries(state.scope) }
      catch (error) { this.report('index', error) }
    }
    const previousEntries = new Map(previousRecords.map(record => [record.id, record]))
    const usedIds = new Set<string>()
    if (state.scope.scopeKind === 'global') {
      for (const scope of this.listScopes().filter(scope => scope.scopeKind === 'project')) {
        for (const path of managedFiles(scope)) {
          const absolute = join(this.directories.resolve(scope.scopeId), path)
          assertMemoryFilePath(absolute, this.memoryRoot)
          if (!existsSync(absolute)) continue
          for (const line of parseMemoryFile(readFileSync(absolute)).lines) {
            if (line.type === 'entry' && line.entry.metadata.id) usedIds.add(line.entry.metadata.id)
          }
        }
      }
    }
    const ledgerEvents = parseMemoryLedger(state.ledgerText).events
    const creates = new Set(ledgerEvents.filter(event => event.op === 'create').map(event => event.id))
    const at = this.now()
    const events: MemoryLedgerEvent[] = []
    const presentIds = new Set<string>()
    for (const [path, file] of state.files) {
      for (let index = 0; index < file.model.lines.length; index++) {
        const line = file.model.lines[index]
        if (line.type !== 'entry') continue
        const kind = kindForFile(path) ?? line.entry.metadata.kind
        if (!kind || (path === 'archive.md' && (!line.entry.metadata.status || !line.entry.metadata.until)) ||
          (state.scope.scopeKind === 'global' && kind === 'project_fact')) {
          file.model.lines[index] = { type: 'invalid', raw: line.raw, eol: line.eol }; file.model.issues++; continue
        }
        const metadata = line.entry.metadata
        if (file.model.readOnly) { if (metadata.id) presentIds.add(metadata.id); continue }
        if (!metadata.id || usedIds.has(metadata.id)) {
          metadata.id = this.uniqueId(usedIds)
          metadata.by = 'user'
          metadata.added = localMemoryDate(at)
        }
        usedIds.add(metadata.id)
        presentIds.add(metadata.id)
        const prior = previousEntries.get(metadata.id)
        if (prior && prior.content !== line.entry.text) {
          metadata.by = 'user'
          delete metadata.src; delete metadata.fp
          events.push({ v: 1, op: 'touch', id: metadata.id, at, conf: 1 })
        }
        if (!creates.has(metadata.id)) {
          events.push({ v: 1, op: 'create', id: metadata.id, at: file.mtime, conf: 1, source: 'user_message', via: 'user-edit' })
          creates.add(metadata.id)
        }
      }
    }
    const hasReadOnlyFile = [...state.files.values()].some(file => file.model.readOnly)
    const orphanIds = new Set(hasReadOnlyFile ? [] : parseMemoryLedger(state.ledgerText).lines.flatMap(line => line.id && !presentIds.has(line.id) ? [line.id] : []))
    state.ledgerText = this.filterLedger(state.ledgerText, orphanIds)
    this.appendLedger(state, events)
  }

  private uniqueId(ids: ReadonlySet<string>): string {
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = this.generateId()
      if (!/^m_[0-9a-z]{10}$/.test(id)) throw new Error('Invalid generated memory ID')
      if (!ids.has(id)) return id
    }
    throw new Error('Unable to allocate a unique memory ID')
  }

  private entries(state: ScopeState): StoredMemoryEntry[] {
    const cached = this.projections.get(state)
    if (cached) return cached.entries
    const ledger = parseMemoryLedger(state.ledgerText).events
    const provenance = new Map<string, MemoryLedgerEvent[]>()
    for (const event of ledger) {
      const events = provenance.get(event.id) ?? []
      events.push(event)
      provenance.set(event.id, events)
    }
    const predecessors = new Map<string, string>()
    for (const file of state.files.values()) {
      for (const line of file.model.lines) {
        if (line.type === 'entry' && line.entry.metadata.by_id && line.entry.metadata.id) {
          predecessors.set(line.entry.metadata.by_id, line.entry.metadata.id)
        }
      }
    }
    const entries: StoredMemoryEntry[] = []
    for (const [path, file] of state.files) {
      for (const line of file.model.lines) {
        if (line.type !== 'entry') continue
        const metadata = line.entry.metadata
        const kind = kindForFile(path) ?? metadata.kind
        if (!metadata.id || !metadata.by || !metadata.added || !kind) continue
        const machine = reduceMemoryLedger(provenance.get(metadata.id) ?? [], metadata.id, file.mtime)
        const location = fileLocation(path)
        const status: MemoryStatus = location === 'inbox' ? 'pending' : location === 'archive'
          ? metadata.status ?? 'retracted' : metadata.verify ? 'needs_verification' : 'active'
        entries.push({
          record: { id: metadata.id, ...state.scope, kind, memoryKey: metadata.key ?? null,
            content: line.entry.text, status, confidence: machine.confidence,
            explicitness: BY_TO_EXPLICIT[metadata.by], sourceType: machine.sourceType,
            validFrom: machine.createdAt, validTo: metadata.until ? new Date(metadata.until + 'T00:00:00').getTime() : null,
            supersedesId: predecessors.get(metadata.id) ?? null, evidenceCount: machine.evidenceCount, distinctSessionCount: machine.distinctSessionCount,
            distinctProjectCount: machine.distinctProjectCount, sourcePath: metadata.src ?? null,
            sourceFingerprint: metadata.fp ?? null, createdAt: machine.createdAt,
            updatedAt: machine.updatedAt, lastSeenAt: machine.lastSeenAt, metadata: null },
          relPath: path, location, aliases: [...(metadata.aliases ?? [])], pinned: metadata.pin === '1',
          addedDate: metadata.added, via: machine.via
        })
      }
    }
    if (this.scopes.get(state.scope.scopeId) === state) this.projections.set(state, { entries, byId: new Map(entries.map(entry => [entry.record.id, entry])) })
    return entries
  }

  private pathForStatus(entry: MemoryFileEntry, kind: MemoryKind, status: MemoryStatus, at: number): string {
    delete entry.metadata.kind; delete entry.metadata.status; delete entry.metadata.until; delete entry.metadata.verify
    if (status === 'pending') { entry.metadata.kind = kind; return 'inbox.md' }
    if (status === 'superseded' || status === 'retracted') {
      entry.metadata.kind = kind; entry.metadata.status = status; entry.metadata.until = localMemoryDate(at)
      return 'archive.md'
    }
    if (status === 'needs_verification') entry.metadata.verify = '1'
    return MEMORY_TOPIC_FILES[kind]
  }

  private entryLine(entry: MemoryFileEntry, newline: string): MemoryFileLine {
    const raw = serializeMemoryEntryLine(entry)
    return { type: 'entry', entry, raw, original: JSON.stringify(entry), eol: newline }
  }

  private appendEntry(state: ScopeState, path: string, entry: MemoryFileEntry): void {
    if (!state.files.has(path)) {
      const title = kindForFile(path) ? MEMORY_TOPIC_TITLES[kindForFile(path)!] : path === 'inbox.md' ? '# Inbox (not yet confirmed)' : '# Archive'
      state.files.set(path, { model: parseMemoryFile(`${MEMORY_FILE_HEADER}\n${title}\n\n`), original: null, fingerprint: null, mtime: this.now() })
    }
    const model = state.files.get(path)!.model
    if (model.readOnly) throw new Error('Memory file is read-only')
    const last = model.lines.at(-1)
    if (last && !last.eol) last.eol = model.newline
    model.lines.push(this.entryLine(entry, model.newline))
  }

  private appendLedger(state: ScopeState, events: readonly MemoryLedgerEvent[]): void {
    for (const event of events) {
      if (!parseMemoryLedger(JSON.stringify(event)).events.length) throw new Error('Invalid memory provenance')
    }
    if (events.length) state.ledgerText += (state.ledgerText && !state.ledgerText.endsWith('\n') ? '\n' : '') + events.map(event => JSON.stringify(event)).join('\n') + '\n'
  }

  private evidenceEvents(id: string, evidence: readonly MemoryEvidenceDraft[], at: number): MemoryLedgerEvent[] {
    return evidence.map(item => ({ v: 1, op: 'evidence', id, at: item.createdAt ?? at, type: item.evidenceType,
      session: item.sessionId ?? undefined, message: item.messageId ?? undefined,
      project: item.projectScopeId ?? undefined, excerpt: item.excerpt ?? undefined }))
  }

  private filterLedger(text: string, ids: ReadonlySet<string>): string {
    if (!ids.size) return text
    const retained = parseMemoryLedger(text).lines.filter(line => line.id === null || !ids.has(line.id))
    return retained.length ? retained.map(line => line.raw).join('\n') + '\n' : ''
  }

  private confidence(state: ScopeState, id: string): number {
    return reduceMemoryLedger(parseMemoryLedger(state.ledgerText).events, id, this.now()).confidence
  }

  private locate(state: ScopeState, id: string): [string, number, MemoryFileEntry] | null {
    for (const [path, file] of state.files) {
      const index = file.model.lines.findIndex(line => line.type === 'entry' && line.entry.metadata.id === id)
      const line = file.model.lines[index]
      if (line?.type === 'entry') return [path, index, line.entry]
    }
    return null
  }

  private mutateEntry(scope: MemoryScope, id: string, action: (state: ScopeState, entry: MemoryFileEntry, path: string, index: number) => void): boolean {
    let found = false
    this.mutate(scope, state => {
      const located = this.locate(state, id)
      if (!located) return
      const [path, index, entry] = located
      if (state.files.get(path)!.model.readOnly) throw new Error('Memory file is read-only')
      action(state, entry, path, index); found = true
    })
    return found
  }

  private mutate(scope: MemoryScope, action: (state: ScopeState) => void): void {
    if (this.readOnly) throw new Error('Memory migration failed; files are read-only')
    for (let attempt = 0; ; attempt++) {
      const state = clone(this.load(scope))
      action(state)
      try { this.commit(state); return }
      catch (error) {
        if (!(error instanceof MemoryFileConflictError) || attempt >= 1) throw error
      }
    }
  }

  private commit(state: ScopeState): void {
    const backups: Array<{ path: string; bytes: Uint8Array | null; fingerprint: string | null }> = []
    const ledgerPath = join(state.dir, '.ledger.jsonl')
    assertMemoryFilePath(ledgerPath, this.memoryRoot)
    if (memoryFileFingerprint(ledgerPath) !== state.ledgerFingerprint) throw new MemoryFileConflictError(ledgerPath)
    const originalLedger = state.ledgerFingerprint === null ? '' : readFileSync(ledgerPath, 'utf8')
    const ordered = [...state.files].sort(([a], [b]) => Number(a === 'archive.md') - Number(b === 'archive.md'))
    try {
      for (const [path, file] of ordered) {
        if (file.model.readOnly) continue
        const content = serializeMemoryFile(file.model)
        if (file.original && Buffer.from(file.original).toString('utf8') === content) continue
        const absolute = join(state.dir, path)
        this.writeFile(absolute, content, { memoryRoot: this.memoryRoot, expectedFingerprint: file.fingerprint })
        backups.push({ path: absolute, bytes: file.original, fingerprint: memoryFileFingerprint(absolute) })
        file.original = Buffer.from(content)
        file.fingerprint = memoryFileFingerprint(absolute)
        file.mtime = lstatSync(absolute).mtimeMs
      }
      if (state.ledgerText !== originalLedger) {
        if (memoryFileFingerprint(ledgerPath) !== state.ledgerFingerprint) throw new MemoryFileConflictError(ledgerPath)
        backups.push({ path: ledgerPath, bytes: state.ledgerFingerprint === null ? null : Buffer.from(originalLedger), fingerprint: state.ledgerFingerprint })
        if (state.ledgerText.startsWith(originalLedger)) {
          const appended = parseMemoryLedger(state.ledgerText.slice(originalLedger.length)).events
          try { new MemoryLedger(ledgerPath, this.memoryRoot, this.options.appendLedgerFile).append(appended) }
          catch (error) { backups[backups.length - 1].fingerprint = memoryFileFingerprint(ledgerPath); throw error }
        } else this.writeFile(ledgerPath, state.ledgerText, { memoryRoot: this.memoryRoot, expectedFingerprint: state.ledgerFingerprint })
        state.ledgerFingerprint = memoryFileFingerprint(ledgerPath)
        state.ledgerText = readFileSync(ledgerPath, 'utf8')
        backups[backups.length - 1].fingerprint = state.ledgerFingerprint
      }
    } catch (error) {
      const failures: unknown[] = [error]
      for (const backup of backups.reverse()) {
        try {
          if (memoryFileFingerprint(backup.path) !== backup.fingerprint) throw new MemoryFileConflictError(backup.path)
          if (backup.bytes === null) { if (backup.fingerprint !== null) { assertMemoryFilePath(backup.path, this.memoryRoot); unlinkSync(backup.path) } }
          else this.writeFile(backup.path, backup.bytes, { memoryRoot: this.memoryRoot, expectedFingerprint: backup.fingerprint })
        } catch (rollbackError) { failures.push(rollbackError) }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'Memory write and rollback failed')
      throw error
    }
    this.scopes.set(state.scope.scopeId, state)
    const entries = clone(this.entries(state))
    try { this.options.onIndexChanged?.(state.scope, entries) }
    catch (error) { this.report('index', error) }
    try {
      const scope = this.snapshotData(state, entries)
      const rendered = renderMemorySnapshot({ capturedAt: this.now(), [state.scope.scopeKind]: scope })
      if (rendered.budgetOverflow) console.warn('[MemoryEntryStore] snapshot exceeded its character budget')
      this.writeFile(join(state.dir, 'MEMORY.md'), MEMORY_GENERATED_HEADER + '\n' + rendered.body, { memoryRoot: this.memoryRoot })
    } catch (error) { this.report('view', error) }
  }

  private report(stage: 'index' | 'view', error: unknown): void {
    if (this.options.onError) this.options.onError(stage, error)
    else console.warn(`[MemoryEntryStore] ${stage} update failed`)
  }
}
