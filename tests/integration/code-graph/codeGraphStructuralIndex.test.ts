import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import {
  discoverCodeFiles,
  createTreeSitterParserRegistry,
  CODE_CONTEXT_QUERY_MAX_CHARS,
  ContextPackBuilder,
  openCodeGraphReader,
  StructuralCodeGraphResolver,
  type CodeIndexOperation
} from '@runtime/code-graph'
import {
  openBetterSqliteCodeGraph,
  type BetterSqliteCodeGraph
} from '@runtime/code-graph/graph/BetterSqliteCodeGraph'

const grammarRoot = resolve('node_modules/@vscode/tree-sitter-wasm/wasm')
const parserOptions = {
  coreWasmPath: resolve('node_modules/web-tree-sitter/web-tree-sitter.wasm'),
  grammarWasmPaths: {
    javascript: resolve(grammarRoot, 'tree-sitter-javascript.wasm'),
    typescript: resolve(grammarRoot, 'tree-sitter-typescript.wasm'),
    tsx: resolve(grammarRoot, 'tree-sitter-tsx.wasm'),
    python: resolve(grammarRoot, 'tree-sitter-python.wasm')
  }
}

interface SymbolEdgeRow {
  readonly sourceName: string
  readonly targetName: string
  readonly kind: string
  readonly confidence: string
  readonly resolver: string
}

interface FileEdgeRow {
  readonly sourcePath: string
  readonly targetPath: string
  readonly kind: string
  readonly confidence: string
  readonly resolver: string
}

interface UnresolvedRow {
  readonly filePath: string
  readonly reason: string
  readonly rawTarget: string
  readonly moduleSpecifier: string | null
}

interface FileRow {
  readonly path: string
  readonly language: string
  readonly parseStatus: string
}

describe('Code Graph structural indexing', () => {
  let tempDir: string | null = null
  let repository: BetterSqliteCodeGraph | null = null

  afterEach(async () => {
    await repository?.close()
    repository = null
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  })

  it('把真实文件发现、结构解析和确定性关系原子写入可查询 generation', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-structural-index-'))
    const workspaceRoot = join(tempDir, 'workspace')
    const dbPath = join(tempDir, 'index.db')
    mkdirSync(join(workspaceRoot, 'src', 'ts'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'src', 'ts', 'tests'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'src', 'js'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'py'), { recursive: true })
    const sources = new Map<string, string>([
      ['src/ts/base.ts', `
export interface Contract { run(value: number): number }
export class Base {}
`],
      ['src/ts/dep.ts', `
export default function defaultFn(value: number) { return value }
export function namedFn(value: number) { return value }
`],
      ['src/ts/impl.ts', 'export function remote(value: number) { return value }\n'],
      ['src/ts/index.ts', "export { remote as forwarded } from './impl'\n"],
      ['src/ts/service.ts', `
import defaultFn, { namedFn } from '@ts/dep'
import { Base, Contract } from './base'
import { forwarded } from './index'
import { packageFeature } from 'nova-fixture/feature'
import { internalFeature } from '#feature'

function normalize(value: number) { return value }
export class Service extends Base implements Contract {
  run(value: number) {
    forwarded(value)
    return defaultFn(namedFn(normalize(value)))
  }
  packageCall() { return packageFeature() }
  internalCall() { return internalFeature() }
  dynamic(client: { run(): void }) { return client.run() }
}
`],
      ['src/ts/view.tsx', `
import { Service } from './service'
type Props = { service: Service }
export function View({ service }: Props) { return <button>{service.run(1)}</button> }
`],
      ['src/ts/service.test.ts', `
import { Service } from './service'
new Service().run(1)
`],
      ['src/ts/tests/service.integration.ts', `
import { Service } from '../service'
new Service().run(1)
`],
      ['src/js/dep.js', 'export const value = 1\n'],
      ['src/js/module.mjs', "import { value } from './dep.js'\nexport function read() { return value }\n"],
      ['src/js/view.jsx', "import { value } from './dep.js'\nexport function View() { return <span>{value}</span> }\n"],
      ['src/js/dep.cjs', 'const read = function () { return 1 }\nmodule.exports = { read }\n'],
      ['src/js/consumer.cjs', "const { read } = require('./dep.cjs')\nconst consume = function () { return read() }\nexports.consume = consume\n"],
      ['py/base.py', 'class Base:\n    pass\n'],
      ['py/dep.py', 'def work(value):\n    return value\n'],
      ['py/service.py', `
from .dep import work
from py.base import Base

def normalize(value):
    return value

class Service(Base):
    def run(self, value):
        return work(normalize(value))

    def dynamic(self, client):
        return client.run()
`],
      ['py/test_service.py', `
from .service import Service

def test_service():
    return Service().run(1)
`]
    ])
    const configs = new Map<string, string>([
      ['tsconfig.json', `{
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "@ts/*": ["src/ts/*"] }
        }
      }`],
      ['package.json', `{
        "name": "nova-fixture",
        "exports": { "./feature": { "import": "./src/ts/dep.ts" } },
        "imports": { "#feature": { "import": "./src/ts/dep.ts" } }
      }`]
    ])
    for (const [relativePath, source] of [...sources, ...configs]) {
      writeFileSync(join(workspaceRoot, ...relativePath.split('/')), source)
    }

    const discovery = await discoverCodeFiles({
      workspaceRoot,
      listGitFiles: async () => [...sources.keys(), ...configs.keys()].reverse()
    })
    expect(discovery.files.map((file) => file.path)).toEqual([...sources.keys()].sort())
    expect(discovery.configFiles).toEqual(['package.json', 'tsconfig.json'])

    const parser = await createTreeSitterParserRegistry(parserOptions)
    const parsedFiles = await Promise.all(discovery.files.map((file) => {
      if (file.language === 'unsupported') {
        throw new Error(`发现结果错误地包含不支持语言：${file.path}`)
      }
      return parser.parse({
        path: file.path,
        language: file.language,
        source: readFileSync(join(workspaceRoot, ...file.path.split('/')), 'utf8')
      })
    }))
    expect(parsedFiles.flatMap((file) => file.imports.map((item) => [
      file.path,
      item.moduleSpecifier
    ]))).toEqual(expect.arrayContaining([
      ['src/js/module.mjs', './dep.js'],
      ['src/js/view.jsx', './dep.js'],
      ['src/js/consumer.cjs', './dep.cjs']
    ]))
    expect(parsedFiles.flatMap((file) => file.exports.map((item) => [
      file.path,
      item.exportedName,
      item.localName
    ]))).toEqual(expect.arrayContaining([
      ['src/js/dep.cjs', 'read', 'read'],
      ['src/js/consumer.cjs', 'consume', 'consume']
    ]))
    const resolver = new StructuralCodeGraphResolver()
    const generation = await resolver.resolve({
      workspaceRoot,
      operationId: 'structural-index',
      generation: 1,
      parserSignature: parser.signature,
      stagedAt: 100,
      parsedFiles,
      configFiles: discovery.configFiles,
      mtimeMsByPath: new Map(discovery.files.map((file) => [file.path, file.mtimeMs]))
    })

    repository = openBetterSqliteCodeGraph({
      dbPath,
      workspaceIdentity: 'workspace-structural',
      parserSignature: parser.signature,
      resolverSignature: resolver.signature,
      now: () => 100
    })
    const operation: CodeIndexOperation = {
      operationId: 'structural-index',
      kind: 'full-rebuild',
      workspaceIdentity: 'workspace-structural',
      generation: 1,
      baseGeneration: null,
      baseRevision: 0
    }
    await repository.claimOperation(operation)
    await repository.stageGeneration(generation)
    await repository.activateGeneration({
      operationId: operation.operationId,
      workspaceIdentity: operation.workspaceIdentity,
      generation: operation.generation,
      expectedActiveGeneration: null,
      expectedRevision: 0,
      completedAt: 200
    })

    expect(await repository.getCoverage()).toMatchObject({
      eligibleFiles: 17,
      indexedFiles: 17,
      parseFailures: 0,
      unresolvedRelations: generation.unresolvedRelations.length
    })
    const inspection = new Database(dbPath, { readonly: true })
    const symbolEdges = inspection.prepare<[], SymbolEdgeRow>(
      `SELECT source.name AS sourceName, target.name AS targetName,
              edge.kind, edge.confidence, edge.resolver
       FROM symbol_edges edge
       JOIN symbols source ON source.id = edge.source_symbol_id
       JOIN symbols target ON target.id = edge.target_symbol_id
       ORDER BY sourceName, targetName, edge.kind`
    ).all()
    const fileEdges = inspection.prepare<[], FileEdgeRow>(
      `SELECT source.path AS sourcePath, target.path AS targetPath,
              edge.kind, edge.confidence, edge.resolver
       FROM file_edges edge
       JOIN files source ON source.id = edge.source_file_id
       JOIN files target ON target.id = edge.target_file_id
       ORDER BY sourcePath, targetPath, edge.kind`
    ).all()
    const unresolved = inspection.prepare<[], UnresolvedRow>(
      `SELECT file.path AS filePath, relation.reason,
              relation.raw_target AS rawTarget,
              relation.module_specifier AS moduleSpecifier
       FROM unresolved_relations relation
       JOIN files file ON file.id = relation.file_id
       ORDER BY filePath, relation.reason, rawTarget`
    ).all()
    const indexedFiles = inspection.prepare<[], FileRow>(
      `SELECT path, language, parse_status AS parseStatus
       FROM files ORDER BY path`
    ).all()
    inspection.close()

    expect(symbolEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetName: 'normalize',
        kind: 'calls',
        confidence: 'confirmed',
        resolver: 'structural'
      }),
      expect.objectContaining({
        targetName: 'defaultFn',
        kind: 'calls',
        confidence: 'probable',
        resolver: 'tsconfig-paths'
      }),
      expect.objectContaining({
        targetName: 'namedFn',
        kind: 'calls',
        confidence: 'probable',
        resolver: 'tsconfig-paths'
      }),
      expect.objectContaining({
        targetName: 'remote',
        kind: 'calls',
        confidence: 'probable',
        resolver: 'index-re-export'
      }),
      expect.objectContaining({
        targetName: 'Base',
        kind: 'extends',
        confidence: 'probable'
      }),
      expect.objectContaining({
        targetName: 'Contract',
        kind: 'implements',
        confidence: 'probable',
        resolver: 'relative-path'
      }),
      expect.objectContaining({
        targetName: 'work',
        kind: 'calls',
        confidence: 'probable',
        resolver: 'python-import'
      }),
      expect.objectContaining({
        targetName: 'read',
        kind: 'calls',
        confidence: 'probable',
        resolver: 'relative-path'
      })
    ]))
    expect(fileEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourcePath: 'src/ts/service.ts',
        targetPath: 'src/ts/dep.ts',
        kind: 'imports',
        confidence: 'probable',
        resolver: 'tsconfig-paths'
      }),
      expect.objectContaining({
        sourcePath: 'src/js/consumer.cjs',
        targetPath: 'src/js/dep.cjs',
        kind: 'imports',
        confidence: 'probable',
        resolver: 'relative-path'
      }),
      expect.objectContaining({
        sourcePath: 'src/ts/service.test.ts',
        targetPath: 'src/ts/service.ts',
        kind: 'test_of',
        confidence: 'probable',
        resolver: 'test-convention'
      }),
      expect.objectContaining({
        sourcePath: 'py/test_service.py',
        targetPath: 'py/service.py',
        kind: 'test_of',
        confidence: 'probable',
        resolver: 'test-convention'
      }),
      expect.objectContaining({
        sourcePath: 'src/ts/tests/service.integration.ts',
        targetPath: 'src/ts/service.ts',
        kind: 'test_of',
        confidence: 'probable',
        resolver: 'test-convention'
      })
    ]))
    expect(unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'py/service.py',
        reason: 'dynamic_dispatch',
        rawTarget: 'client.run'
      }),
      expect.objectContaining({
        reason: 'external_module',
        moduleSpecifier: 'nova-fixture/feature'
      }),
      expect.objectContaining({
        reason: 'unsupported_conditional_export',
        moduleSpecifier: '#feature'
      })
    ]))
    expect(indexedFiles).toHaveLength(17)
    expect(indexedFiles).toEqual(expect.arrayContaining([
      { path: 'src/ts/view.tsx', language: 'tsx', parseStatus: 'parsed' },
      { path: 'src/js/dep.js', language: 'javascript', parseStatus: 'parsed' },
      { path: 'src/js/view.jsx', language: 'jsx', parseStatus: 'parsed' },
      { path: 'src/js/module.mjs', language: 'mjs', parseStatus: 'parsed' },
      { path: 'src/js/consumer.cjs', language: 'cjs', parseStatus: 'parsed' },
      { path: 'py/service.py', language: 'python', parseStatus: 'parsed' }
    ]))
    expect(generation.symbolEdges.every((edge) =>
      edge.resolver === 'structural' || edge.confidence === 'probable'
    )).toBe(true)

    const reader = openCodeGraphReader({ dbPath })
    try {
      const context = new ContextPackBuilder({ reader })
      const locate = await context.build({
        query: 'Service',
        intent: 'locate',
        scope: 'src/ts',
        status: 'ready'
      })
      const understand = await context.build({
        query: 'run',
        intent: 'understand',
        scope: 'src/ts',
        status: 'ready'
      })
      const impact = await context.build({
        query: 'Service',
        intent: 'impact',
        scope: 'src/ts',
        status: 'updating'
      })
      const tokenQuery = await context.build({
        query: 'named_fn',
        intent: 'locate',
        scope: 'src/ts',
        status: 'ready'
      })

      const locatePack: unknown = JSON.parse(locate)
      const understandPack: unknown = JSON.parse(understand)
      const impactPack: unknown = JSON.parse(impact)
      const tokenPack: unknown = JSON.parse(tokenQuery)
      expect(locatePack).toMatchObject({
        status: 'ready',
        revision: 1,
        intent: 'locate',
        anchors: expect.arrayContaining([
          expect.objectContaining({
            name: 'Service',
            path: 'src/ts/service.ts',
            score: 1
          })
        ])
      })
      expect(understandPack).toMatchObject({
        relations: expect.arrayContaining([
          expect.objectContaining({ type: 'calls', to: 'normalize' }),
          expect.objectContaining({ type: 'calls', to: 'defaultFn' })
        ])
      })
      expect(impactPack).toMatchObject({
        status: 'updating',
        summary: expect.stringContaining('二跳候选'),
        relations: expect.arrayContaining([
          expect.objectContaining({ type: 'test_of', to: 'src/ts/service.ts' }),
          expect.objectContaining({ type: 'implements', to: 'Contract' })
        ]),
        warnings: expect.arrayContaining([
          expect.stringContaining('最近一次已提交 revision'),
          expect.stringContaining('不能据此判断无影响')
        ])
      })
      expect(tokenPack).toMatchObject({
        anchors: expect.arrayContaining([
          expect.objectContaining({ name: 'namedFn' })
        ])
      })
      expect(await context.build({
        query: 'Service',
        intent: 'impact',
        scope: 'src/ts',
        status: 'updating'
      })).toBe(impact)
      expect(impact).not.toContain('\n')
      const oversizedQuery = 'x'.repeat(CODE_CONTEXT_QUERY_MAX_CHARS + 1)
      await expect(reader.readEvidence({
        query: { original: oversizedQuery, folded: oversizedQuery, tokens: ['x'] },
        scope: null,
        relationDepth: 0
      })).rejects.toThrow('不得超过')
      await expect(reader.readEvidence({
        query: { original: 'Service', folded: 'service', tokens: ['service'] },
        scope: 'src//ts',
        relationDepth: 0
      })).rejects.toThrow('规范化工作区相对路径')
      await expect(reader.readEvidence({
        query: { original: 'Service', folded: 'service', tokens: ['service'] },
        scope: 'src/ts/',
        relationDepth: 0
      })).rejects.toThrow('规范化工作区相对路径')
    } finally {
      await reader.close()
    }
  })
})
