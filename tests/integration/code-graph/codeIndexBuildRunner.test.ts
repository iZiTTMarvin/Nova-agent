import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURAL_RESOLVER_SIGNATURE,
  TREE_SITTER_PARSER_SIGNATURE,
  openCodeGraphReader,
  type CodeIndexWorkerRunRequest
} from '@runtime/code-graph'
import { runFullCodeIndexBuild } from '@runtime/code-graph/worker/CodeIndexBuildRunner'

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
})

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
