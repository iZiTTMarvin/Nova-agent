import { app } from 'electron'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import type {
  CodeContextPack,
  CodeContextQueryPort,
  CodeContextQueryRequest,
  CodeGraphReader,
  CodeGraphStateReader,
  CodeIndexCoordinator
} from '../../runtime/code-graph'

export interface CodeGraphRuntimeHandle {
  readonly queryPort: CodeContextQueryPort
  start(): Promise<void>
  close(): Promise<void>
}

export type CodeGraphRuntimeFactory = (workspaceRoot: string) => CodeGraphRuntimeHandle

const runtimes = new Map<string, CodeGraphRuntimeHandle>()
let runtimeFactory: CodeGraphRuntimeFactory | null = null

/** 按工作区复用 Runtime handle；索引状态仍只由 Coordinator 写入。 */
export function ensureCodeGraphForWorkspace(workspaceRoot: string): CodeContextQueryPort {
  const key = cacheKey(workspaceRoot)
  let runtime = runtimes.get(key)
  if (!runtime) {
    runtime = (runtimeFactory ?? createProductionRuntime)(key)
    runtimes.set(key, runtime)
  }
  void runtime.start().catch((error) => {
    console.error('[CodeGraphHost] 工作区索引初始化失败:', error)
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

export function setCodeGraphRuntimeFactoryForTests(
  factory: CodeGraphRuntimeFactory | null
): void {
  runtimeFactory = factory
}

export async function resetCodeGraphHostForTests(): Promise<void> {
  await closeAllCodeGraphs()
  runtimeFactory = null
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

class InitializedCodeGraphRuntime implements CodeGraphRuntimeHandle {
  private opening: Promise<void> | null = null

  constructor(
    private readonly coordinator: CodeIndexCoordinator,
    private readonly workspace: Parameters<CodeIndexCoordinator['openWorkspace']>[0],
    private readonly readerProvider: LazyCodeGraphReaderProvider,
    readonly queryPort: CodeContextQueryPort
  ) {}

  start(): Promise<void> {
    this.opening ??= this.open()
    return this.opening
  }

  async close(): Promise<void> {
    await this.opening?.catch(() => undefined)
    await this.coordinator.closeWorkspace(this.workspace.workspaceIdentity)
    await this.readerProvider.close()
  }

  private async open(): Promise<void> {
    const snapshot = await this.coordinator.openWorkspace(
      this.workspace,
      this.readerProvider
    )
    if (snapshot.activeGeneration === null) {
      // 冷建只在启用后后台调度，不阻塞会话创建与普通工具。
      void this.coordinator.rebuild()
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
  return new InitializedCodeGraphRuntime(coordinator, workspace, readerProvider, engine)
}

function cacheKey(workspaceRoot: string): string {
  const resolved = normalize(resolve(workspaceRoot))
  try {
    return normalize(realpathSync.native(resolved))
  } catch {
    return resolved
  }
}
