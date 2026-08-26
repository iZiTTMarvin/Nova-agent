import { loadIgnoreMatcher, isPathSkipped, type IgnoreMatcher } from '../../runtime/workspace'
import type {
  WorkspaceChange,
  WorkspaceChangeErrorListener,
  WorkspaceChangeListener,
  WorkspaceChangeSource
} from '../../runtime/code-graph'
import { watch as chokidarWatch } from 'chokidar'
import * as path from 'node:path'
import { toWorkspaceRelativePath as toCanonicalWorkspaceRelativePath } from '../../runtime/permissions/pathAccess'

type ChokidarEvent = 'add' | 'change' | 'unlink'

export interface ChokidarWatcher {
  on(event: ChokidarEvent, listener: (filePath: string) => void): ChokidarWatcher
  on(event: 'error', listener: (error: Error) => void): ChokidarWatcher
  on(event: 'ready', listener: () => void): ChokidarWatcher
  close(): Promise<void>
}

export interface ChokidarWatchOptions {
  readonly cwd: string
  readonly ignored: (filePath: string, stats?: unknown) => boolean
  readonly ignoreInitial: true
  readonly followSymlinks: false
  readonly usePolling: false
  readonly disableGlobbing: true
}

export type ChokidarWatchFactory = (
  pathToWatch: string,
  options: ChokidarWatchOptions
) => ChokidarWatcher

export interface CodeGraphWorkspaceWatcherOptions {
  readonly createWatcher?: ChokidarWatchFactory
  readonly loadIgnoreMatcher?: (workspaceRoot: string) => Promise<IgnoreMatcher>
}

export class CodeGraphWorkspaceWatcher implements WorkspaceChangeSource {
  private readonly changeListeners = new Set<WorkspaceChangeListener>()
  private readonly errorListeners = new Set<WorkspaceChangeErrorListener>()
  private closePromise: Promise<void> | null = null
  private terminalError: Error | null = null
  private closed = false
  private refreshIgnorePromise: Promise<void> | null = null
  private readonly readyPromise: Promise<void>
  private resolveReady: (() => void) | null = null
  private rejectReady: ((error: Error) => void) | null = null

  private constructor(
    private readonly watcher: ChokidarWatcher,
    private readonly workspaceRoot: string,
    private readonly ignoreState: { matcher: IgnoreMatcher },
    private readonly reloadIgnoreMatcher: (workspaceRoot: string) => Promise<IgnoreMatcher>
  ) {
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady
      this.rejectReady = rejectReady
    })
    void this.readyPromise.catch(() => undefined)
    for (const event of ['add', 'change', 'unlink'] as const) {
      watcher.on(event, (filePath) => this.emitChange(event, filePath))
    }
    watcher.on('ready', () => this.handleReady())
    watcher.on('error', (error) => this.handleError(error))
  }

  static async create(
    workspaceRoot: string,
    options: CodeGraphWorkspaceWatcherOptions = {}
  ): Promise<CodeGraphWorkspaceWatcher> {
    const normalizedRoot = path.resolve(workspaceRoot)
    const reloadIgnoreMatcher = options.loadIgnoreMatcher ?? loadIgnoreMatcher
    const ignoreState = { matcher: await reloadIgnoreMatcher(normalizedRoot) }
    const createWatcher = options.createWatcher ?? defaultChokidarWatch
    const watcher = createWatcher(normalizedRoot, {
      cwd: normalizedRoot,
      ignored: createIgnoredMatcher(normalizedRoot, () => ignoreState.matcher),
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: false,
      disableGlobbing: true
    })
    return new CodeGraphWorkspaceWatcher(
      watcher,
      normalizedRoot,
      ignoreState,
      reloadIgnoreMatcher
    )
  }

  subscribe(listener: WorkspaceChangeListener): () => void {
    if (this.closed) return () => undefined
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  subscribeError(listener: WorkspaceChangeErrorListener): () => void {
    if (this.terminalError) {
      listener(this.terminalError)
      return () => undefined
    }
    if (this.closed) return () => undefined
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  whenReady(): Promise<void> {
    return this.readyPromise
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.rejectReady?.(new Error('代码索引 watcher 已关闭'))
    this.resolveReady = null
    this.rejectReady = null
    this.changeListeners.clear()
    this.errorListeners.clear()
    this.closePromise = this.watcher.close()
    return this.closePromise
  }

  private emitChange(type: ChokidarEvent, filePath: string): void {
    if (this.closed || this.terminalError) return
    const relativePath = toWorkspaceRelativePath(this.workspaceRoot, filePath)
    if (relativePath === null || relativePath === '') return
    const change: WorkspaceChange = Object.freeze({ type, path: relativePath })
    for (const listener of this.changeListeners) listener(change)
    if (relativePath === '.gitignore') this.refreshIgnoreMatcher()
  }

  private handleError(error: Error): void {
    if (this.terminalError) return
    this.terminalError = normalizeError(error)
    this.rejectReady?.(this.terminalError)
    this.resolveReady = null
    this.rejectReady = null
    for (const listener of this.errorListeners) listener(this.terminalError)
    void this.close().catch((closeError: unknown) => {
      this.handleCloseError(closeError)
    })
  }

  private handleReady(): void {
    if (this.closed || this.terminalError) return
    this.resolveReady?.()
    this.resolveReady = null
    this.rejectReady = null
  }

  private handleCloseError(error: unknown): void {
    const normalized = normalizeError(error)
    if (this.terminalError?.message === normalized.message) return
    for (const listener of this.errorListeners) listener(normalized)
  }

  private refreshIgnoreMatcher(): void {
    if (this.refreshIgnorePromise || this.closed) return
    this.refreshIgnorePromise = this.reloadIgnoreMatcher(this.workspaceRoot)
      .then((matcher) => {
        if (!this.closed) this.ignoreState.matcher = matcher
      })
      .catch((error: unknown) => this.handleError(normalizeError(error)))
      .finally(() => {
        this.refreshIgnorePromise = null
      })
  }
}

export async function createCodeGraphWorkspaceWatcher(
  workspaceRoot: string,
  options: CodeGraphWorkspaceWatcherOptions = {}
): Promise<WorkspaceChangeSource> {
  return CodeGraphWorkspaceWatcher.create(workspaceRoot, options)
}

function defaultChokidarWatch(
  workspaceRoot: string,
  options: ChokidarWatchOptions
): ChokidarWatcher {
  // 禁止轮询兜底；递归监听失败必须由上层进入 degraded，而不是制造高 CPU 主路径。
  return chokidarWatch(workspaceRoot, options)
}

function createIgnoredMatcher(
  workspaceRoot: string,
  getIgnoreMatcher: () => IgnoreMatcher
): (filePath: string, stats?: unknown) => boolean {
  return (filePath: string, _stats?: unknown): boolean => {
    const relativePath = toWorkspaceRelativePath(workspaceRoot, filePath)
    if (relativePath === null) return true
    if (relativePath === '') return false
    if (relativePath === '.gitignore') return false
    if (relativePath.split('/').some(isPathSkipped)) return true
    return getIgnoreMatcher()(relativePath, false)
  }
}

function toWorkspaceRelativePath(workspaceRoot: string, filePath: string): string | null {
  if (!filePath || filePath.includes('\0')) return null
  const relativePath = toCanonicalWorkspaceRelativePath(
    workspaceRoot,
    path.resolve(workspaceRoot, filePath)
  )
  if (relativePath === null) return null
  if (relativePath === '.') return ''
  const posixPath = path.posix.normalize(relativePath)
  if (posixPath === '.' || posixPath === '..' || posixPath.startsWith('../')) return null
  return posixPath
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
