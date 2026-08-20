import { beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { ParserRegistry } from '@runtime/code-graph/parsing/ParserRegistry'
import { createTreeSitterParserRegistry } from '@runtime/code-graph/parsing/TreeSitterParser'
import {
  STRUCTURAL_RESOLVER_SIGNATURE,
  StructuralCodeGraphResolver
} from '@runtime/code-graph/resolving/Resolver'

const grammarRoot = resolve('node_modules/@vscode/tree-sitter-wasm/wasm')

describe('StructuralCodeGraphResolver', () => {
  let registry: ParserRegistry

  beforeAll(async () => {
    registry = await createTreeSitterParserRegistry({
      coreWasmPath: resolve('node_modules/web-tree-sitter/web-tree-sitter.wasm'),
      grammarWasmPaths: {
        javascript: resolve(grammarRoot, 'tree-sitter-javascript.wasm'),
        typescript: resolve(grammarRoot, 'tree-sitter-typescript.wasm'),
        tsx: resolve(grammarRoot, 'tree-sitter-tsx.wasm'),
        python: resolve(grammarRoot, 'tree-sitter-python.wasm')
      }
    })
  })

  async function parseFixture() {
    return Promise.all([
      registry.parse({
        path: 'src/dep.ts',
        language: 'typescript',
        source: `export default function defaultFn() { return 1 }
export function depFn(value: number) { return value }
`
      }),
      registry.parse({
        path: 'src/base.ts',
        language: 'typescript',
        source: 'export class Base {}\n'
      }),
      registry.parse({
        path: 'src/impl.ts',
        language: 'typescript',
        source: 'export function remote() { return 1 }\n'
      }),
      registry.parse({
        path: 'src/index.ts',
        language: 'typescript',
        source: "export { remote as forwarded } from './impl'\n"
      }),
      registry.parse({
        path: 'src/public.ts',
        language: 'typescript',
        source: "export { forwarded as deepForwarded } from './index'\n"
      }),
      registry.parse({
        path: 'src/service.ts',
        language: 'typescript',
        source: `import defaultFn, { depFn as callDep } from './dep'
import { Base } from './base'
import { forwarded } from './index'
import { deepForwarded } from './public'
import { missing } from 'external-package'

function local() { return defaultFn() }
export class Service extends Base {
  run(value: number) {
    callDep(value)
    forwarded()
    deepForwarded()
    local()
    return object.dynamic()
  }
}
`
      }),
      registry.parse({
        path: 'src/service.test.ts',
        language: 'typescript',
        source: "import { Service } from './service'\nnew Service().run(1)\n"
      })
    ])
  }

  it('唯一关系写边，动态/外部关系写 unresolved，跨文件不标 confirmed', async () => {
    const parsedFiles = await parseFixture()
    const resolver = new StructuralCodeGraphResolver()
    const result = await resolver.resolve({
      workspaceRoot: '/workspace',
      operationId: 'operation-1',
      generation: 1,
      parserSignature: registry.signature,
      stagedAt: 100,
      parsedFiles,
      configFiles: [],
      mtimeMsByPath: new Map(parsedFiles.map((file) => [file.path, 100]))
    })

    expect(result.resolverSignature).toBe(STRUCTURAL_RESOLVER_SIGNATURE)
    expect(result.fileEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourcePath: 'src/service.ts',
        targetPath: 'src/dep.ts',
        kind: 'imports',
        confidence: 'probable'
      }),
      expect.objectContaining({
        sourcePath: 'src/index.ts',
        targetPath: 'src/impl.ts',
        kind: 're_exports'
      }),
      expect.objectContaining({
        sourcePath: 'src/service.test.ts',
        targetPath: 'src/service.ts',
        kind: 'test_of'
      })
    ]))
    expect(result.symbolEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'calls', confidence: 'confirmed', resolver: 'structural' }),
      expect.objectContaining({ kind: 'calls', confidence: 'probable', resolver: 'relative-path' }),
      expect.objectContaining({ kind: 'calls', confidence: 'probable', resolver: 'index-re-export' }),
      expect.objectContaining({ kind: 'extends', confidence: 'probable', resolver: 'relative-path' })
    ]))
    expect(result.symbolEdges.filter((edge) => edge.resolver !== 'structural'))
      .toSatisfy((edges) => edges.every((edge) => edge.confidence === 'probable'))
    expect(result.unresolvedRelations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/service.ts',
        kind: 'imports',
        rawTarget: 'external-package',
        reason: 'external_module'
      }),
      expect.objectContaining({
        filePath: 'src/service.ts',
        kind: 'calls',
        rawTarget: 'object.dynamic',
        reason: 'dynamic_dispatch'
      }),
      expect.objectContaining({
        filePath: 'src/service.ts',
        kind: 'calls',
        rawTarget: 'deepForwarded',
        reason: 'reexport_depth_exceeded',
        resolver: 'index-re-export'
      })
    ]))
  })

  it('输入顺序变化不改变 generation payload 字节', async () => {
    const parsedFiles = await parseFixture()
    const resolver = new StructuralCodeGraphResolver()
    const base = {
      workspaceRoot: '/workspace',
      operationId: 'operation-stable',
      generation: 2,
      parserSignature: registry.signature,
      stagedAt: 200,
      configFiles: [] as readonly string[],
      mtimeMsByPath: new Map(parsedFiles.map((file) => [file.path, 100]))
    }

    const forward = await resolver.resolve({ ...base, parsedFiles })
    const reverse = await resolver.resolve({ ...base, parsedFiles: [...parsedFiles].reverse() })
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward))
  })

  it('批量关系解析持续检查取消边界', async () => {
    const [template] = await parseFixture()
    if (!template) throw new Error('缺少 resolver fixture')
    const parsedFiles = Array.from({ length: 40 }, (_, index) => ({
      ...template,
      path: `src/generated-${index}.ts`
    }))
    let checks = 0

    await expect(new StructuralCodeGraphResolver().resolve({
      workspaceRoot: '/workspace',
      operationId: 'operation-cancel',
      generation: 3,
      parserSignature: registry.signature,
      stagedAt: 300,
      parsedFiles,
      configFiles: [],
      mtimeMsByPath: new Map(parsedFiles.map((file) => [file.path, 100]))
    }, {
      throwIfCancelled: () => {
        checks += 1
        if (checks >= 25) throw new Error('resolver cancelled')
      }
    })).rejects.toThrow('resolver cancelled')
    expect(checks).toBeGreaterThanOrEqual(25)
  })
})
