import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  getCodeGraphDbPath,
  getCodeGraphWorkspaceDir,
  computeCodeGraphWorkspaceIdentity,
  normalizeCodeGraphWorkspaceRoot
} from './CodeGraphPaths'
import { CodeGraphEngine } from './context'
import type { CodeContextQueryPort } from './context'
import type { CodeGraphStateReader } from './graph/CodeGraphRepository'
import {
  openCodeGraphReader,
  type CodeGraphReader
} from './graph/queries/CodeGraphReader'
import {
  CodeIndexCoordinator,
  type CodeGraphStateReaderProvider
} from './indexing/CodeIndexCoordinator'
import { TREE_SITTER_PARSER_SIGNATURE } from './parsing/TreeSitterParser'
import { STRUCTURAL_RESOLVER_SIGNATURE } from './resolving/Resolver'
import { CodeIndexWorkerClient } from './worker/CodeIndexWorkerClient'
import type { CodeIndexWorkerWorkspace } from './worker/protocol'

export interface CodeGraphRuntimeAssemblyOptions {
  readonly workspaceRoot: string
  readonly appDataPath: string
  readonly workerPath: string
  readonly grammarRoot: string
}

export interface CodeGraphRuntimeReaderProvider extends CodeGraphStateReaderProvider {
  getReader(): Promise<(CodeGraphReader & CodeGraphStateReader) | null>
  close(): Promise<void>
}

export interface CodeGraphRuntimeAssembly {
  readonly coordinator: CodeIndexCoordinator
  readonly workspace: CodeIndexWorkerWorkspace
  readonly readerProvider: CodeGraphRuntimeReaderProvider
  readonly queryPort: CodeContextQueryPort
}

/** 桌面与 headless 共用同一套 Coordinator、Worker、SQLite 只读装配。 */
export function createCodeGraphRuntimeAssembly(
  options: CodeGraphRuntimeAssemblyOptions
): CodeGraphRuntimeAssembly {
  const workspaceIdentity = computeCodeGraphWorkspaceIdentity(options.workspaceRoot)
  mkdirSync(getCodeGraphWorkspaceDir(options.appDataPath, workspaceIdentity), {
    recursive: true
  })
  const dbPath = getCodeGraphDbPath(options.appDataPath, workspaceIdentity)
  const readerProvider = new LazyCodeGraphReaderProvider(dbPath)
  const coordinator = new CodeIndexCoordinator({
    createWorker: () => new CodeIndexWorkerClient({ workerPath: options.workerPath })
  })
  const queryPort = new CodeGraphEngine({
    getSnapshot: () => coordinator.getSnapshot(),
    getReader: () => readerProvider.getReader()
  })
  const workspace = Object.freeze({
    workspaceIdentity,
    workspaceRoot: normalizeCodeGraphWorkspaceRoot(options.workspaceRoot),
    dbPath,
    parserSignature: TREE_SITTER_PARSER_SIGNATURE,
    resolverSignature: STRUCTURAL_RESOLVER_SIGNATURE,
    coreWasmPath: join(options.grammarRoot, 'web-tree-sitter.wasm'),
    grammarWasmPaths: Object.freeze({
      javascript: join(options.grammarRoot, 'tree-sitter-javascript.wasm'),
      typescript: join(options.grammarRoot, 'tree-sitter-typescript.wasm'),
      tsx: join(options.grammarRoot, 'tree-sitter-tsx.wasm'),
      python: join(options.grammarRoot, 'tree-sitter-python.wasm')
    })
  })
  return Object.freeze({ coordinator, workspace, readerProvider, queryPort })
}

class LazyCodeGraphReaderProvider implements CodeGraphRuntimeReaderProvider {
  private reader: (CodeGraphReader & CodeGraphStateReader) | null = null

  constructor(private readonly dbPath: string) {}

  async getStateReader(): Promise<CodeGraphStateReader | null> {
    return this.getReader()
  }

  async getReader(): Promise<(CodeGraphReader & CodeGraphStateReader) | null> {
    if (this.reader) return this.reader
    if (!existsSync(this.dbPath)) return null
    this.reader = openCodeGraphReader({ dbPath: this.dbPath })
    return this.reader
  }

  async close(): Promise<void> {
    const reader = this.reader
    this.reader = null
    await reader?.close()
  }
}

