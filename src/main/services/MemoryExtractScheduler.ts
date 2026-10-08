import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertMemoryFilePath, writeFileAtomic, memoryFileFingerprint } from '../../runtime/memory/markdown/atomicFile'
import { MEMORY_EXTRACT_CURSOR_RETENTION_DAYS, MEMORY_EXTRACT_IDLE_DELAY_MS, MEMORY_EXTRACT_MAX_ATTEMPTS } from '../../runtime/memory/memoryConfig'

export interface MemoryExtractCursor {
  lastMessageId: string | null
  processedAt: number
  attempts: number
  lastError: string | null
}
export interface MemoryExtractOutcome { lastMessageId: string | null; failed?: boolean; excluded?: boolean; deferred?: boolean }
interface PendingExtract { workspaceRoot: string; readyAt: number }

export interface MemoryExtractSchedulerDeps {
  memoryRoot: string
  enabled: () => boolean
  exists: (sessionId: string) => boolean
  execute: (sessionId: string, workspaceRoot: string, cursor: MemoryExtractCursor | undefined, signal: AbortSignal) => Promise<MemoryExtractOutcome>
  now?: () => number
}

/** Owns the persistent cursor and the globally serial extraction queue. */
export class MemoryExtractScheduler {
  private readonly cursors = new Map<string, MemoryExtractCursor>()
  private readonly pending = new Map<string, PendingExtract>()
  private readonly now: () => number
  private readonly path: string
  private fingerprint: string | null = null
  private timer?: ReturnType<typeof setTimeout>
  private running: { sessionId: string; controller: AbortController; promise: Promise<void> } | null = null
  private disposed = false

  constructor(private readonly deps: MemoryExtractSchedulerDeps) {
    this.now = deps.now ?? Date.now
    this.path = join(deps.memoryRoot, 'extract-state.json')
    assertMemoryFilePath(this.path, deps.memoryRoot)
    this.fingerprint = memoryFileFingerprint(this.path)
    if (existsSync(this.path)) {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1 || !('sessions' in raw) || !raw.sessions || typeof raw.sessions !== 'object' || Array.isArray(raw.sessions)) throw new Error('Invalid extraction cursor state')
      for (const [id, value] of Object.entries(raw.sessions)) {
        if (!value || typeof value !== 'object' || !('lastMessageId' in value) || !(value.lastMessageId === null || typeof value.lastMessageId === 'string') || !('processedAt' in value) || typeof value.processedAt !== 'number' || !Number.isFinite(value.processedAt) || value.processedAt < 0 || !('attempts' in value) || typeof value.attempts !== 'number' || !Number.isSafeInteger(value.attempts) || value.attempts < 0 || !('lastError' in value) || !(value.lastError === null || typeof value.lastError === 'string')) throw new Error('Invalid extraction cursor')
        if (this.now() - value.processedAt <= MEMORY_EXTRACT_CURSOR_RETENTION_DAYS * 86_400_000 && deps.exists(id)) this.cursors.set(id, { lastMessageId: value.lastMessageId, processedAt: value.processedAt, attempts: value.attempts, lastError: value.lastError })
      }
      this.persist()
    }
  }

  getCursor(sessionId: string): MemoryExtractCursor | undefined {
    const cursor = this.cursors.get(sessionId)
    return cursor ? { ...cursor } : undefined
  }

  enqueue(sessionId: string, workspaceRoot: string, delay = MEMORY_EXTRACT_IDLE_DELAY_MS): void {
    if (this.disposed || !this.deps.enabled()) return
    this.pending.set(sessionId, { workspaceRoot, readyAt: this.now() + delay })
    this.arm()
  }

  onTurnStarted(sessionId: string): void {
    const pending = this.pending.get(sessionId)
    if (pending) { pending.readyAt = this.now() + MEMORY_EXTRACT_IDLE_DELAY_MS; this.arm() }
  }

  async runNow(sessionId: string, workspaceRoot: string): Promise<void> {
    this.enqueue(sessionId, workspaceRoot, 0)
    while (this.pending.has(sessionId) || this.running?.sessionId === sessionId) {
      await this.pump()
      if (this.running) await this.running.promise
      const item = this.pending.get(sessionId)
      if (item && item.readyAt > this.now()) break
    }
  }

  removeSession(sessionId: string): void {
    this.pending.delete(sessionId)
    if (this.running?.sessionId === sessionId) this.running.controller.abort()
    if (this.cursors.delete(sessionId)) this.persist()
    this.arm()
  }

  advanceThrough(sessionId: string, lastMessageId: string | null): void {
    this.pending.delete(sessionId)
    if (this.running?.sessionId === sessionId) this.running.controller.abort()
    if (!this.deps.exists(sessionId)) return
    this.cursors.set(sessionId, { lastMessageId, processedAt: this.now(), attempts: 0, lastError: null })
    this.persist(); this.arm()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.pending.clear()
    this.running?.controller.abort()
  }

  private persist(): void {
    writeFileAtomic(this.path, JSON.stringify({ version: 1, sessions: Object.fromEntries(this.cursors) }), { memoryRoot: this.deps.memoryRoot, expectedFingerprint: this.fingerprint })
    this.fingerprint = memoryFileFingerprint(this.path)
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.disposed || this.running || !this.pending.size) return
    const at = Math.min(...Array.from(this.pending.values(), item => item.readyAt))
    this.timer = setTimeout(() => { void this.pump().catch(() => console.error('[MemoryExtract] queue unavailable')) }, Math.max(0, at - this.now()))
    this.timer.unref?.()
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return
    const next = [...this.pending].find(([, item]) => item.readyAt <= this.now())
    if (!next) { this.arm(); return }
    const [sessionId, item] = next
    this.pending.delete(sessionId)
    if (!this.deps.enabled() || !this.deps.exists(sessionId)) { this.arm(); return }
    const controller = new AbortController()
    const promise = this.execute(sessionId, item, controller)
    this.running = { sessionId, controller, promise }
    try { await promise } finally { this.running = null; this.arm() }
  }

  private async execute(sessionId: string, item: PendingExtract, controller: AbortController): Promise<void> {
    // Defer execution until the running owner is installed, including synchronous failures.
    await Promise.resolve()
    const previous = this.cursors.get(sessionId)
    let result: MemoryExtractOutcome
    try { result = await this.deps.execute(sessionId, item.workspaceRoot, previous, controller.signal) }
    catch { result = { lastMessageId: previous?.lastMessageId ?? null, failed: true } }
    if (result.deferred) { if (!controller.signal.aborted) this.enqueue(sessionId, item.workspaceRoot); return }
    if (result.excluded || controller.signal.aborted || this.disposed || !this.deps.exists(sessionId)) return
    const attempts = result.failed ? (previous && previous.attempts < MEMORY_EXTRACT_MAX_ATTEMPTS ? previous.attempts : 0) + 1 : 0
    const exhausted = attempts >= MEMORY_EXTRACT_MAX_ATTEMPTS
    this.cursors.set(sessionId, {
      lastMessageId: result.failed && !exhausted ? previous?.lastMessageId ?? null : result.lastMessageId,
      processedAt: this.now(), attempts, lastError: result.failed ? 'extraction-failed' : null
    })
    this.persist()
    if (result.failed && !exhausted && this.deps.enabled()) this.enqueue(sessionId, item.workspaceRoot)
  }
}
