import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  openBetterSqliteCodeGraph,
  type BetterSqliteCodeGraph
} from '@runtime/code-graph/graph/BetterSqliteCodeGraph'
import type {
  CodeGraphGenerationInput,
  CodeGraphIncrementalUpdate,
  CodeIndexOperation
} from '@runtime/code-graph'
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeGraphMigrationError
} from '@runtime/code-graph/graph/schema/CodeGraphMigrations'

describe('Code Graph SQLite persistence', () => {
  let tempDir: string | null = null
  let repository: BetterSqliteCodeGraph | null = null

  afterEach(async () => {
    await repository?.close()
    repository = null
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  })

  function newDbPath(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-code-graph-'))
    return join(tempDir, 'index.db')
  }

  function open(dbPath = newDbPath()): BetterSqliteCodeGraph {
    repository = openBetterSqliteCodeGraph({
      dbPath,
      workspaceIdentity: 'workspace-a',
      parserSignature: 'parser-v1',
      resolverSignature: 'resolver-v1',
      now: () => 100
    })
    return repository
  }

  function graphGeneration(
    generation: number,
    operationId: string,
    hash = 'hash-v1'
  ): CodeGraphGenerationInput {
    return {
      operationId,
      generation,
      parserSignature: 'parser-v1',
      resolverSignature: 'resolver-v1',
      stagedAt: 100,
      files: [
        {
          path: 'src/a.ts',
          language: 'typescript',
          contentHash: hash,
          sizeBytes: 20,
          mtimeMs: 100,
          lineCount: 2,
          parseStatus: 'parsed'
        },
        {
          path: 'src/b.ts',
          language: 'typescript',
          contentHash: 'hash-b',
          sizeBytes: 10,
          mtimeMs: 100,
          lineCount: 1,
          parseStatus: 'parsed'
        }
      ],
      symbols: [
        {
          stableId: 'symbol:a',
          filePath: 'src/a.ts',
          name: 'runA',
          qualifiedName: 'runA',
          kind: 'function',
          exported: true,
          signature: 'runA(): void',
          docExcerpt: 'Runs A.',
          identifierTokens: 'run a runa',
          startLine: 1,
          endLine: 2,
          startByte: 0,
          endByte: 20
        },
        {
          stableId: 'symbol:b',
          filePath: 'src/b.ts',
          name: 'runB',
          qualifiedName: 'runB',
          kind: 'function',
          exported: true,
          signature: 'runB(): void',
          docExcerpt: null,
          identifierTokens: 'run b runb',
          startLine: 1,
          endLine: 1,
          startByte: 0,
          endByte: 10
        }
      ],
      fileEdges: [
        {
          sourcePath: 'src/a.ts',
          targetPath: 'src/b.ts',
          kind: 'imports',
          confidence: 'probable',
          resolver: 'relative-path',
          sourceLine: 1
        }
      ],
      symbolEdges: [
        {
          sourceSymbolId: 'symbol:a',
          targetSymbolId: 'symbol:b',
          kind: 'calls',
          confidence: 'confirmed',
          resolver: 'structural',
          sourceFile: 'src/a.ts',
          sourceLine: 2
        }
      ],
      unresolvedRelations: [
        {
          filePath: 'src/a.ts',
          sourceSymbolId: 'symbol:a',
          kind: 'references',
          rawTarget: 'externalCall',
          moduleSpecifier: 'external-package',
          sourceLine: 2,
          reason: 'external_module',
          resolver: 'relative-path'
        }
      ]
    }
  }

  function operation(
    operationId: string,
    kind: CodeIndexOperation['kind'],
    generation: number,
    baseGeneration: number | null,
    baseRevision: number
  ): CodeIndexOperation {
    return {
      operationId,
      kind,
      workspaceIdentity: 'workspace-a',
      generation,
      baseGeneration,
      baseRevision
    }
  }

  it('安全创建并幂等打开独立 schema，拒绝高版本数据库', async () => {
    const dbPath = newDbPath()
    const opened = open(dbPath)
    expect(await opened.getMetadata()).toMatchObject({
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
      workspaceIdentity: 'workspace-a',
      activeGeneration: null,
      revision: 0,
      lastAccessed: 100
    })

    const inspection = new Database(dbPath, { readonly: true })
    const objects = inspection.prepare(
      `SELECT name FROM sqlite_master
       WHERE name IN (
         'index_meta', 'generations', 'files', 'symbols', 'file_edges',
         'symbol_edges', 'unresolved_relations', 'symbol_fts'
       ) ORDER BY name`
    ).all()
    inspection.close()
    expect(objects).toHaveLength(8)

    await opened.close()
    repository = null
    const reopened = open(dbPath)
    expect(await reopened.getMetadata()).toMatchObject({ revision: 0 })
    await reopened.close()
    repository = null

    const newer = new Database(dbPath)
    newer.pragma(`user_version = ${CODE_GRAPH_SCHEMA_VERSION + 1}`)
    newer.close()
    expect(() => open(dbPath)).toThrow(CodeGraphMigrationError)
    repository = null
  })

  it('full rebuild 只在 activation 事务后切换 generation，失败不污染 last-good', async () => {
    const opened = open()
    const first = graphGeneration(1, 'operation-1')
    await opened.claimOperation(operation('operation-1', 'full-rebuild', 1, null, 0))
    await opened.stageGeneration(first)
    expect(await opened.findActiveFile('src/a.ts')).toBeNull()

    const firstMetadata = await opened.activateGeneration({
      operationId: 'operation-1',
      workspaceIdentity: 'workspace-a',
      generation: 1,
      expectedActiveGeneration: null,
      expectedRevision: 0,
      completedAt: 200
    })
    expect(firstMetadata).toMatchObject({ activeGeneration: 1, revision: 1 })
    expect(await opened.findActiveFile('src/a.ts')).toMatchObject({
      generation: 1,
      contentHash: 'hash-v1'
    })

    const invalidBase = graphGeneration(2, 'operation-invalid', 'hash-invalid')
    const invalid: CodeGraphGenerationInput = {
      ...invalidBase,
      fileEdges: [{ ...invalidBase.fileEdges[0], targetPath: 'src/missing.ts' }]
    }
    await opened.claimOperation(operation('operation-invalid', 'full-rebuild', 2, 1, 1))
    await expect(opened.stageGeneration(invalid)).rejects.toThrow(
      'file edge target 无法解析'
    )
    expect(await opened.getMetadata()).toMatchObject({ activeGeneration: 1, revision: 1 })
    expect(await opened.findActiveFile('src/a.ts')).toMatchObject({
      generation: 1,
      contentHash: 'hash-v1'
    })

    const second = graphGeneration(2, 'operation-2', 'hash-v2')
    const secondOperation = operation('operation-2', 'full-rebuild', 2, 1, 1)
    await opened.claimOperation(secondOperation)
    await opened.stageGeneration(second)
    expect(await opened.findActiveFile('src/a.ts')).toMatchObject({ contentHash: 'hash-v1' })
    await opened.releaseOperation(secondOperation)
    await expect(opened.activateGeneration({
      operationId: 'operation-2',
      workspaceIdentity: 'workspace-a',
      generation: 2,
      expectedActiveGeneration: 1,
      expectedRevision: 1,
      completedAt: 300
    })).rejects.toThrow('write fence 已失效')

    await opened.claimOperation(secondOperation)
    await expect(opened.activateGeneration({
      operationId: 'operation-stale',
      workspaceIdentity: 'workspace-a',
      generation: 2,
      expectedActiveGeneration: 1,
      expectedRevision: 1,
      completedAt: 300
    })).rejects.toThrow('write fence 已失效')
    const secondMetadata = await opened.activateGeneration({
      operationId: 'operation-2',
      workspaceIdentity: 'workspace-a',
      generation: 2,
      expectedActiveGeneration: 1,
      expectedRevision: 1,
      completedAt: 300
    })
    expect(secondMetadata).toMatchObject({ activeGeneration: 2, revision: 2 })
    expect(await opened.findActiveFile('src/a.ts')).toMatchObject({
      generation: 2,
      contentHash: 'hash-v2'
    })
    await opened.deleteGeneration(1)
    await expect(opened.deleteGeneration(2)).rejects.toThrow('active generation')
  })

  it('增量批次原子替换文件并只推进一次 revision', async () => {
    const opened = open()
    await opened.claimOperation(operation('operation-1', 'full-rebuild', 1, null, 0))
    await opened.stageGeneration(graphGeneration(1, 'operation-1'))
    await opened.activateGeneration({
      operationId: 'operation-1',
      workspaceIdentity: 'workspace-a',
      generation: 1,
      expectedActiveGeneration: null,
      expectedRevision: 0,
      completedAt: 200
    })

    const invalid: CodeGraphIncrementalUpdate = {
      operationId: 'incremental-invalid',
      workspaceIdentity: 'workspace-a',
      generation: 1,
      expectedRevision: 1,
      completedAt: 250,
      removedPaths: [],
      files: [{
        path: 'src/a.ts',
        language: 'typescript',
        contentHash: 'hash-invalid',
        sizeBytes: 25,
        mtimeMs: 200,
        lineCount: 2,
        parseStatus: 'parsed'
      }],
      symbols: [{
        stableId: 'symbol:a2',
        filePath: 'src/a.ts',
        name: 'runA2',
        qualifiedName: 'runA2',
        kind: 'function',
        exported: true,
        signature: null,
        docExcerpt: null,
        identifierTokens: 'run a 2 runa2',
        startLine: 1,
        endLine: 2,
        startByte: 0,
        endByte: 25
      }],
      fileEdges: [{
        sourcePath: 'src/a.ts',
        targetPath: 'src/missing.ts',
        kind: 'imports',
        confidence: 'probable',
        resolver: 'relative-path',
        sourceLine: 1
      }],
      symbolEdges: [],
      unresolvedRelations: []
    }
    await opened.claimOperation(
      operation('incremental-invalid', 'incremental-update', 1, 1, 1)
    )
    await expect(opened.applyIncrementalUpdate(invalid)).rejects.toThrow(
      'file edge target 无法解析'
    )
    expect(await opened.getMetadata()).toMatchObject({ revision: 1 })
    expect(await opened.findActiveFile('src/a.ts')).toMatchObject({ contentHash: 'hash-v1' })

    const canceledOperation = operation(
      'incremental-canceled',
      'incremental-update',
      1,
      1,
      1
    )
    await opened.claimOperation(canceledOperation)
    await opened.releaseOperation(canceledOperation)
    await expect(opened.applyIncrementalUpdate({
      ...invalid,
      operationId: 'incremental-canceled',
      fileEdges: []
    })).rejects.toThrow('write fence 已失效')
    expect(await opened.getMetadata()).toMatchObject({ revision: 1 })

    const valid: CodeGraphIncrementalUpdate = {
      ...invalid,
      operationId: 'incremental-1',
      completedAt: 300,
      removedPaths: ['src/b.ts'],
      files: [{ ...invalid.files[0], contentHash: 'hash-v2' }],
      fileEdges: []
    }
    await opened.claimOperation(
      operation('incremental-1', 'incremental-update', 1, 1, 1)
    )
    const committed = await opened.applyIncrementalUpdate(valid)
    expect(committed).toMatchObject({ activeGeneration: 1, revision: 2 })
    expect(await opened.findActiveFile('src/a.ts')).toMatchObject({ contentHash: 'hash-v2' })
    expect(await opened.findActiveFile('src/b.ts')).toBeNull()
    expect(await opened.getCoverage()).toMatchObject({
      eligibleFiles: 1,
      indexedFiles: 1,
      unresolvedRelations: 0
    })
  })

  it('拒绝非规范工作区路径', async () => {
    const opened = open()
    await opened.claimOperation(operation('operation-path', 'full-rebuild', 1, null, 0))
    const invalid = graphGeneration(1, 'operation-path')
    await expect(opened.stageGeneration({
      ...invalid,
      files: [{ ...invalid.files[0], path: './src/a.ts' }, invalid.files[1]]
    })).rejects.toThrow('规范化工作区相对路径')
  })
})
