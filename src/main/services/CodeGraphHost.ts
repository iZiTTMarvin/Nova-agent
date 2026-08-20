import { app } from 'electron'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import type {
  CodeContextPack,
  CodeContextQueryPort,
  CodeContextQueryRequest,
  CodeGraphReader,
  CodeGraphStateReader,
  CodeGraphCacheGcOptions,
  CodeGraphCacheGcResult,
  CodeIndexCoordinator,
  CodeIndexWorkerWorkspace,
  CodeGraphStateReaderProvider,
  WorkspaceChangeSource
} from '../../runtime/code-graph'

export interface CodeGraphRuntimeHandle {
  readonly queryPort: CodeContextQueryPort
  start(): Promise<void>
  touchAccess(accessedAt: number): Promise<void>
  close(): Promise<void>
}

export type CodeGraphRuntimeFactory = (workspaceRoot: string) => CodeGraphRuntimeHandle

type CodeGraphCoordinatorHostPort = Pick<
  CodeIndexCoordinator,
  | 'getSnapshot'
  | 'openWorkspace'
  | 'closeWorkspace'
  | 'rebuild'
  | 'checkDrift'
  | 'touchAccess'
  | 'notifyWorkspaceChange'
  | 'reportChangeSourceFailure'
>

interface CodeGraphRuntimeReaderProvider extends CodeGraphStateReaderProvider {
  close(): Promise<void>
}

const runtimes = new Map<string, CodeGraphRuntimeHandle>()
let runtimeFactory: CodeGraphRuntimeFactory | null = null
let startupGcScheduled = false
let startupGcRunner: ((options: CodeGraphCacheGcOptions) => Promise<CodeGraphCacheGcResult>) | null = null

/** 按工作区复用 Runtime handle；索引状态仍只由 Coordinator 写入。 */
export function ensureCodeGraphForWorkspace(workspaceRoot: string): CodeContextQueryPort {
  const key = cacheKey(workspaceRoot)
  let runtime = runtimes.get(key)
  const shouldRecordAccess = runtime === undefined
  if (!runtime) {
    runtime = (runtimeFactory ?? createProductionRuntime)(key)
    runtimes.set(key, runtime)
  }
  void runtime.start()
    .then(() => {
      // 同一活跃期重复取查询端不应只为刷新时间戳唤醒 Worker。
      if (shouldRecordAccess) return runtime.touchAccess(Date.now())
    })
    .catch((error) => {
      console.error('[CodeGraphHost] 工作区索引初始化或访问时间更新失败:', error)
    })
  return runtime.queryPort
}

export function getCodeContextQueryPort(workspaceRoot: string): CodeContextQueryPort | null {
  return runtimes.get(cacheKey(workspaceRoot))?.queryPort ?? null
}

export async function closeCodeGraphForWorkspace(workspaceRoot: string): Promise<void> {
  const key = cacheKey(workspaceRoot)
  const runtime = runtimes.get(key)
  if (!runtime) return
  runtimes.delete(key)
  await runtime.close()
}

export async function closeAllCodeGraphs(): Promise<void> {
  const closing = [...runtimes.values()].map((runtime) => runtime.close())
  runtimes.clear()
  await Promise.allSettled(closing)
}

export function scheduleCodeGraphStartupGc(
  codeIndexEnabled: boolean,
  activeWorkspaceRoot: string | null
): void {
  if (!codeIndexEnabled) return
  if (startupGcScheduled) return
  startupGcScheduled = true
  const workspaceRoot = activeWorkspaceRoot === null ? null : cacheKey(activeWorkspaceRoot)
  setImmediate(() => {
    void import('../../runtime/code-graph')
      .then(async (codeGraph) => {
        // 启动回收只维护既有可重建缓存，不装配 watcher、查询连接或索引 Worker。
        const result = await (startupGcRunner ?? codeGraph.runCodeGraphCacheGc)({
          appDataPath: app.getPath('userData'),
          activeWorkspaceIdentity: workspaceRoot === null
            ? null
            : codeGraph.computeCodeGraphWorkspaceIdentity(workspaceRoot)
        })
        if (result.freedBytes > 0) {
          console.info(`[CodeGraphGC] 已释放 ${result.freedBytes} bytes`)
        }
        for (const diagnostic of result.diagnostics) {
          console.warn(`[CodeGraphGC] ${diagnostic}`)
        }
      })
      .catch((error) => {
        console.error('[CodeGraphGC] 启动回收失败:', error)
      })
  })
}

export function setCodeGraphRuntimeFactoryForTests(
  factory: CodeGraphRuntimeFactory | null
): void {
  runtimeFactory = factory
}

export function setCodeGraphStartupGcRunnerForTests(
  runner: ((options: CodeGraphCacheGcOptions) => Promise<CodeGraphCacheGcResult>) | null
): void {
  startupGcRunner = runner
}

export async function resetCodeGraphHostForTests(): Promise<void> {
  await closeAllCodeGraphs()
  runtimeFactory = null
  startupGcScheduled = false
  startupGcRunner = null
}

export function codeGraphRuntimeCountForTests(): number {
  return runtimes.size
}

function createProductionRuntime(workspaceRoot: string): CodeGraphRuntimeHandle {
  return new LazyProductionCodeGraphRuntime(workspaceRoot)
}

class LazyProductionCodeGraphRuntime implements CodeGraphRuntimeHandle {
  private initialized: Promise<InitializedCodeGraphRuntime> | null = null
  readonly queryPort: CodeContextQueryPort = Object.freeze({
    query: async (request: CodeContextQueryRequest): Promise<CodeContextPack> => {
      const runtime = await this.getInitialized()
      await runtime.start()
      return runtime.queryPort.query(request)
    }
  })

  constructor(private readonly workspaceRoot: string) {}

  async start(): Promise<void> {
    const runtime = await this.getInitialized()
    await runtime.start()
  }

  async touchAccess(accessedAt: number): Promise<void> {
    const runtime = await this.getInitialized()
    await runtime.start()
    await runtime.touchAccess(accessedAt)
  }

  async close(): Promise<void> {
    if (!this.initialized) return
    const runtime = await this.initialized.catch(() => null)
    if (runtime) await runtime.close()
  }

  private getInitialized(): Promise<InitializedCodeGraphRuntime> {
    this.initialized ??= initializeProductionRuntime(this.workspaceRoot)
    return this.initialized
  }
}

export class InitializedCodeGraphRuntime implements CodeGraphRuntimeHandle {
  private opening: Promise<void> | null = null
  private changeSource: WorkspaceChangeSource | null = null
  private unsubscribeChange: (() => void) | null = null
  private unsubscribeError: (() => void) | null = null

  constructor(
    private readonly coordinator: CodeGraphCoordinatorHostPort,
    private readonly workspace: CodeIndexWorkerWorkspace,
    private readonly readerProvider: CodeGraphRuntimeReaderProvider,
    private readonly createChangeSource: () => Promise<WorkspaceChangeSource>,
    readonly queryPort: CodeContextQueryPort
  ) {}

  start(): Promise<void> {
    this.opening ??= this.open()
    return this.opening
  }

  async touchAccess(accessedAt: number): Promise<void> {
    await this.start()
    await this.coordinator.touchAccess(accessedAt)
  }

  async close(): Promise<void> {
    await this.opening?.catch(() => undefined)
    this.unsubscribeChange?.()
    this.unsubscribeError?.()
    this.unsubscribeChange = null
    this.unsubscribeError = null
    const changeSource = this.changeSource
    this.changeSource = null
    await changeSource?.close()
    await this.coordinator.closeWorkspace(this.workspace.workspaceIdentity)
    await this.readerProvider.close()
  }

  private async open(): Promise<void> {
    const snapshot = await this.coordinator.openWorkspace(
      this.workspace,
      this.readerProvider
    )
    try {
      const changeSource = await this.createChangeSource()
      this.changeSource = changeSource
      this.unsubscribeChange = changeSource.subscribe((change) => {
        this.coordinator.notifyWorkspaceChange(change)
      })
      this.unsubscribeError = changeSource.subscribeError((error) => {
        this.coordinator.reportChangeSourceFailure(error)
      })
      // 先完成 watcher 初始枚举再做 drift，避免 ignoreInitial 留下新鲜度空窗。
      void changeSource.whenReady()
        .then(() => {
          if (this.changeSource === changeSource) this.scheduleFreshnessCheck(snapshot)
        })
        .catch(() => {
          if (this.changeSource === changeSource) this.scheduleFreshnessCheck(snapshot)
        })
    } catch (error) {
      this.coordinator.reportChangeSourceFailure(error)
      this.scheduleFreshnessCheck(snapshot)
    }
  }

  private scheduleFreshnessCheck(snapshot: ReturnType<CodeGraphCoordinatorHostPort['getSnapshot']>): void {
    if (snapshot.activeGeneration === null) {
      // 冷建只在启用后后台调度，不阻塞会话创建与普通工具。
      void this.coordinator.rebuild()
    } else {
      void this.coordinator.checkDrift()
    }
  }
}

class LazyCodeGraphReaderProvider {
  private reader: (CodeGraphReader & CodeGraphStateReader) | null = null

  constructor(
    private readonly dbPath: string,
    private readonly openReader: (dbPath: string) => CodeGraphReader & CodeGraphStateReader
  ) {}

  async getStateReader(): Promise<CodeGraphStateReader | null> {
    return this.getReader()
  }

  async getReader(): Promise<(CodeGraphReader & CodeGraphStateReader) | null> {
    if (this.reader) return this.reader
    if (!existsSync(this.dbPath)) return null
    this.reader = this.openReader(this.dbPath)
    return this.reader
  }

  async close(): Promise<void> {
    const reader = this.reader
    this.reader = null
    await reader?.close()
  }
}

async function initializeProductionRuntime(
  workspaceRoot: string
): Promise<InitializedCodeGraphRuntime> {
  // 重量索引模块只在功能实际启用后加载，默认关闭时不打开 DB 或 Worker。
  const codeGraph = await import('../../runtime/code-graph')
  const { createCodeGraphWorkspaceWatcher } = await import('./CodeGraphWorkspaceWatcher')
  const workspaceIdentity = codeGraph.computeCodeGraphWorkspaceIdentity(workspaceRoot)
  const workspaceDir = codeGraph.getCodeGraphWorkspaceDir(
    app.getPath('userData'),
    workspaceIdentity
  )
  mkdirSync(workspaceDir, { recursive: true })
  const dbPath = codeGraph.getCodeGraphDbPath(app.getPath('userData'), workspaceIdentity)
  const workerPath = join(__dirname, 'codeGraphWorker.js')
  const grammarRoot = join(__dirname, 'code-graph', 'grammars')
  const readerProvider = new LazyCodeGraphReaderProvider(
    dbPath,
    (path) => codeGraph.openCodeGraphReader({ dbPath: path })
  )
  const coordinator = new codeGraph.CodeIndexCoordinator({
    createWorker: () => new codeGraph.CodeIndexWorkerClient({ workerPath })
  })
  const engine = new codeGraph.CodeGraphEngine({
    getSnapshot: () => coordinator.getSnapshot(),
    getReader: () => readerProvider.getReader()
  })
  const workspace = Object.freeze({
    workspaceIdentity,
    workspaceRoot: codeGraph.normalizeCodeGraphWorkspaceRoot(workspaceRoot),
    dbPath,
    parserSignature: codeGraph.TREE_SITTER_PARSER_SIGNATURE,
    resolverSignature: codeGraph.STRUCTURAL_RESOLVER_SIGNATURE,
    coreWasmPath: join(grammarRoot, 'web-tree-sitter.wasm'),
    grammarWasmPaths: Object.freeze({
      javascript: join(grammarRoot, 'tree-sitter-javascript.wasm'),
      typescript: join(grammarRoot, 'tree-sitter-typescript.wasm'),
      tsx: join(grammarRoot, 'tree-sitter-tsx.wasm'),
      python: join(grammarRoot, 'tree-sitter-python.wasm')
    })
  })
  return new InitializedCodeGraphRuntime(
    coordinator,
    workspace,
    readerProvider,
    () => createCodeGraphWorkspaceWatcher(workspace.workspaceRoot),
    engine
  )
}

function cacheKey(workspaceRoot: string): string {
  const resolved = normalize(resolve(workspaceRoot))
  try {
    return normalize(realpathSync.native(resolved))
  } catch {
    return resolved
  }
}
