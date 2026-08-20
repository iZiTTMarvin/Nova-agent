import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodeGraphEngine,
  CodeIndexCoordinator,
  STRUCTURAL_RESOLVER_SIGNATURE,
  TREE_SITTER_PARSER_SIGNATURE,
  openCodeGraphReader,
  type CodeIndexFailure,
  type CodeIndexWorkerPort,
  type CodeIndexWorkerRunOptions,
  type CodeIndexWorkerRunRequest
} from '@runtime/code-graph'
import {
  runCodeIndexWork,
  runCodeIndexTouchAccess,
  runFullCodeIndexBuild,
  runIncrementalCodeIndexBuild
} from '@runtime/code-graph/worker/CodeIndexBuildRunner'

const tempRoots: string[] = []
const grammarRoot = resolve('node_modules/@vscode/tree-sitter-wasm/wasm')

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('CodeIndexBuildRunner', () => {
  it('在单一 Worker 写路径中完成发现、解析、解析关系与 generation 提交', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-code-worker-'))
    tempRoots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const dbPath = join(root, 'index', 'index.db')
    mkdirSync(join(workspaceRoot, 'src'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'src', 'dep.ts'), 'export function dep() { return 1 }')
    writeFileSync(
      join(workspaceRoot, 'src', 'main.ts'),
      "import { dep } from './dep'\nexport function main() { return dep() }"
    )
    writeFileSync(join(workspaceRoot, 'src', 'broken.ts'), 'export function {')
    writeFileSync(join(workspaceRoot, 'src', 'other.go'), 'package other')
    const progress = vi.fn()

    const result = await runFullCodeIndexBuild(request(workspaceRoot, dbPath), {
      cpuCount: 2,
      onProgress: progress
    })

    expect(result).toMatchObject({
      metadata: {
        workspaceIdentity: 'workspace-worker',
        activeGeneration: 1,
        revision: 1
      },
      coverage: {
        eligibleFiles: 3,
        indexedFiles: 2,
        parseFailures: 1,
        unsupportedFiles: 1
      }
    })
    expect(progress).toHaveBeenLastCalledWith({ completed: 4, total: 4 })

    const reader = openCodeGraphReader({ dbPath })
    try {
      await expect(reader.getMetadata()).resolves.toMatchObject({
        activeGeneration: 1,
        revision: 1
      })
      await expect(reader.nextGeneration()).resolves.toBe(2)
      await expect(reader.getCoverage()).resolves.toMatchObject({ indexedFiles: 2 })
      const evidence = await reader.readEvidence({
        query: { original: 'main', folded: 'main', tokens: ['main'] },
        scope: null,
        relationDepth: 1
      })
      expect(evidence.anchors).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'main', path: 'src/main.ts' })
      ]))
      expect(evidence.relations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'calls', to: 'dep' })
      ]))
    } finally {
      await reader.close()
    }
  })

  it('已取消的构建不打开数据库或留下半成品', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-code-worker-cancel-'))
    tempRoots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const dbPath = join(root, 'index', 'index.db')
    mkdirSync(workspaceRoot, { recursive: true })
    writeFileSync(join(workspaceRoot, 'main.ts'), 'export const main = 1')
    const controller = new AbortController()
    controller.abort()

    await expect(runFullCodeIndexBuild(request(workspaceRoot, dbPath), {
      abortSignal: controller.signal
    })).rejects.toMatchObject({ code: 'build_cancelled' })
    expect(existsSync(dbPath)).toBe(false)
  })

  it('小批修改原子推进 revision 并重建受影响关系，随后 drift 不重复解析', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-code-worker-incremental-'))
    tempRoots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const dbPath = join(root, 'index', 'index.db')
    mkdirSync(join(workspaceRoot, 'src'), { recursive: true })
    const depPath = join(workspaceRoot, 'src', 'dep.ts')
    const mainPath = join(workspaceRoot, 'src', 'main.ts')
    const packagePath = join(workspaceRoot, 'package.json')
    writeFileSync(packagePath, '{"name":"fixture-a"}')
    writeFileSync(depPath, 'export function dep() { return 1 }')
    writeFileSync(
      mainPath,
      "import { dep } from './dep'\nexport function main() { return dep() }"
    )
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(
        join(workspaceRoot, 'src', `stable-${index}.ts`),
        `export const stable${index} = ${index}`
      )
    }
    await runFullCodeIndexBuild(request(workspaceRoot, dbPath))

    writeFileSync(depPath, 'export function dep2() { return 2 }')
    writeFileSync(
      mainPath,
      "import { dep2 } from './dep'\nexport function main() { return dep2() }"
    )
    const incremental = await runIncrementalCodeIndexBuild(
      incrementalRequest(workspaceRoot, dbPath, 1, [
        { type: 'change', path: 'src/dep.ts' },
        { type: 'change', path: 'src/main.ts' }
      ])
    )
    expect(incremental).toMatchObject({
      outcome: 'committed',
      metadata: { activeGeneration: 1, revision: 2 }
    })

    const reader = openCodeGraphReader({ dbPath })
    try {
      const evidence = await reader.readEvidence({
        query: { original: 'main', folded: 'main', tokens: ['main'] },
        scope: null,
        relationDepth: 1
      })
      expect(evidence.relations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'calls', to: 'dep2' })
      ]))
      expect(JSON.stringify(evidence)).not.toContain('"to":"dep"')
    } finally {
      await reader.close()
    }

    const beforeDrift = openCodeGraphReader({ dbPath })
    const lastAccessedBeforeDrift = (await beforeDrift.getMetadata()).lastAccessed
    await beforeDrift.close()
    const drift = await runIncrementalCodeIndexBuild(
      incrementalRequest(workspaceRoot, dbPath, 2, null),
      { now: () => 987_654 }
    )
    expect(drift).toMatchObject({
      outcome: 'unchanged',
      metadata: { revision: 2, lastAccessed: lastAccessedBeforeDrift }
    })

    const accessedAt = lastAccessedBeforeDrift + 1
    const touched = await runCodeIndexTouchAccess(
      touchAccessRequest(workspaceRoot, dbPath, 2, accessedAt),
      { now: () => 987_654 }
    )
    expect(touched).toMatchObject({
      outcome: 'unchanged',
      metadata: { revision: 2, lastAccessed: accessedAt }
    })

    rmSync(depPath)
    const removed = await runIncrementalCodeIndexBuild(
      incrementalRequest(workspaceRoot, dbPath, 2, [
        { type: 'unlink', path: 'src/dep.ts' }
      ])
    )
    expect(removed).toMatchObject({ outcome: 'committed', metadata: { revision: 3 } })
    const readerAfterDelete = openCodeGraphReader({ dbPath })
    try {
      const evidence = await readerAfterDelete.readEvidence({
        query: { original: 'main', folded: 'main', tokens: ['main'] },
        scope: null,
        relationDepth: 1
      })
      expect(evidence.relations).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'calls', to: 'dep2' })
      ]))
      expect(evidence.unresolved).toEqual(expect.arrayContaining([
        expect.objectContaining({ filePath: 'src/main.ts', reason: 'no_matching_file' })
      ]))
    } finally {
      await readerAfterDelete.close()
    }

    writeFileSync(depPath, 'export function dep2() { return 3 }')
    const restored = await runIncrementalCodeIndexBuild(
      incrementalRequest(workspaceRoot, dbPath, 3, [
        { type: 'add', path: 'src/dep.ts' }
      ])
    )
    expect(restored).toMatchObject({ outcome: 'committed', metadata: { revision: 4 } })
    const readerAfterAdd = openCodeGraphReader({ dbPath })
    try {
      const evidence = await readerAfterAdd.readEvidence({
        query: { original: 'main', folded: 'main', tokens: ['main'] },
        scope: null,
        relationDepth: 1
      })
      expect(evidence.relations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'calls', to: 'dep2' })
      ]))
    } finally {
      await readerAfterAdd.close()
    }

    writeFileSync(packagePath, '{"name":"fixture-b"}')
    const configDrift = await runIncrementalCodeIndexBuild(
      incrementalRequest(workspaceRoot, dbPath, 4, null)
    )
    expect(configDrift).toMatchObject({
      outcome: 'rebuild-required',
      rebuildReason: 'incompatible-index',
      metadata: { revision: 4 }
    })
  })

  it('文件变化后立即查询 last-good updating，提交后 revision 与关系一起前进', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-code-worker-query-'))
    tempRoots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const dbPath = join(root, 'index', 'index.db')
    mkdirSync(join(workspaceRoot, 'src'), { recursive: true })
    const depPath = join(workspaceRoot, 'src', 'dep.ts')
    const mainPath = join(workspaceRoot, 'src', 'main.ts')
    writeFileSync(depPath, 'export function dep() { return 1 }')
    writeFileSync(
      mainPath,
      "import { dep } from './dep'\nexport function main() { return dep() }"
    )
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(
        join(workspaceRoot, 'src', `stable-${index}.ts`),
        `export const stable${index} = ${index}`
      )
    }
    const fullRequest = request(workspaceRoot, dbPath)
    await runFullCodeIndexBuild(fullRequest)
    const reader = openCodeGraphReader({ dbPath })
    const worker = new PausedInlineWorker()
    const coordinator = new CodeIndexCoordinator({
      createWorker: () => worker,
      changeDebounceMs: 0,
      generateOperationId: () => 'incremental-query'
    })
    await coordinator.openWorkspace(fullRequest.workspace, {
      getStateReader: async () => reader
    })
    const engine = new CodeGraphEngine({
      getSnapshot: () => coordinator.getSnapshot(),
      getReader: async () => reader
    })

    writeFileSync(depPath, 'export function dep2() { return 2 }')
    writeFileSync(
      mainPath,
      "import { dep2 } from './dep'\nexport function main() { return dep2() }"
    )
    coordinator.notifyWorkspaceChange({ type: 'change', path: 'src/dep.ts' })
    coordinator.notifyWorkspaceChange({ type: 'change', path: 'src/main.ts' })
    await vi.waitFor(() => expect(worker.runCalls).toBe(1))

    const during = await engine.query({ query: 'main', intent: 'impact' })
    expect(during).toMatchObject({ status: 'updating', revision: 1 })
    expect(during.warnings.join(' ')).toContain('最近一次已提交 revision')
    expect(during.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ to: 'dep' })
    ]))

    worker.release()
    await vi.waitFor(() => expect(coordinator.getSnapshot().revision).toBe(2))
    const after = await engine.query({ query: 'main', intent: 'impact' })
    expect(after).toMatchObject({ status: 'ready', revision: 2 })
    expect(after.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ to: 'dep2' })
    ]))

    await coordinator.closeWorkspace(fullRequest.workspace.workspaceIdentity)
    await reader.close()
  })
})

class PausedInlineWorker implements CodeIndexWorkerPort {
  runCalls = 0
  private releaseRun: (() => void) | null = null

  async run(
    request: CodeIndexWorkerRunRequest,
    options: CodeIndexWorkerRunOptions = {}
  ) {
    this.runCalls += 1
    await new Promise<void>((resolveRun) => {
      this.releaseRun = resolveRun
    })
    return runCodeIndexWork(request, options)
  }

  release(): void {
    this.releaseRun?.()
    this.releaseRun = null
  }

  async cancel(): Promise<void> {
    this.release()
  }

  async dispose(): Promise<void> {
    this.release()
  }

  onTerminalFailure(_listener: (failure: CodeIndexFailure) => void): () => void {
    return () => undefined
  }
}

function request(workspaceRoot: string, dbPath: string): CodeIndexWorkerRunRequest {
  return {
    operation: {
      operationId: 'operation-worker',
      kind: 'full-rebuild',
      workspaceIdentity: 'workspace-worker',
      generation: 1,
      baseGeneration: null,
      baseRevision: 0
    },
    workspace: {
      workspaceIdentity: 'workspace-worker',
      workspaceRoot,
      dbPath,
      parserSignature: TREE_SITTER_PARSER_SIGNATURE,
      resolverSignature: STRUCTURAL_RESOLVER_SIGNATURE,
      coreWasmPath: resolve('node_modules/web-tree-sitter/web-tree-sitter.wasm'),
      grammarWasmPaths: {
        javascript: resolve(grammarRoot, 'tree-sitter-javascript.wasm'),
        typescript: resolve(grammarRoot, 'tree-sitter-typescript.wasm'),
        tsx: resolve(grammarRoot, 'tree-sitter-tsx.wasm'),
        python: resolve(grammarRoot, 'tree-sitter-python.wasm')
      }
    }
  }
}

function incrementalRequest(
  workspaceRoot: string,
  dbPath: string,
  baseRevision: number,
  changeBatch: CodeIndexWorkerRunRequest['changeBatch']
): CodeIndexWorkerRunRequest {
  const full = request(workspaceRoot, dbPath)
  return {
    ...full,
    operation: {
      operationId: `incremental-${baseRevision}`,
      kind: 'incremental-update',
      workspaceIdentity: 'workspace-worker',
      generation: 1,
      baseGeneration: 1,
      baseRevision
    },
    changeBatch
  }
}

function touchAccessRequest(
  workspaceRoot: string,
  dbPath: string,
  baseRevision: number,
  accessedAt: number
): CodeIndexWorkerRunRequest {
  const full = request(workspaceRoot, dbPath)
  return {
    ...full,
    operation: {
      operationId: `touch-${baseRevision}`,
      kind: 'touch-access',
      workspaceIdentity: 'workspace-worker',
      generation: 1,
      baseGeneration: 1,
      baseRevision
    },
    accessedAt
  }
}
