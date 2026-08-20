import { beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { ParserRegistry } from '@runtime/code-graph/parsing/ParserRegistry'
import {
  TREE_SITTER_PARSER_SIGNATURE,
  TreeSitterParser,
  createTreeSitterParserRegistry
} from '@runtime/code-graph/parsing/TreeSitterParser'

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

describe('TreeSitterParser', () => {
  let registry: ParserRegistry

  beforeAll(async () => {
    registry = await createTreeSitterParserRegistry(parserOptions)
  })

  it('抽取 TypeScript 结构、导入导出、继承和直接调用', async () => {
    const parsed = await registry.parse({
      path: 'src/service.ts',
      language: 'typescript',
      source: `
import defaultFn, { depFn as callDep } from './dep'
export { remote as forwarded } from './bridge'
class LocalBase {}
interface Contract {}
export class Service extends LocalBase implements Contract {
  run(value: number) { return callDep(value) }
}
export function helper() { return defaultFn() }
`
    })

    expect(parsed.parseStatus).toBe('parsed')
    expect(parsed.symbols.map((symbol) => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ['module', 'src/service.ts'],
        ['class', 'LocalBase'],
        ['interface', 'Contract'],
        ['class', 'Service'],
        ['method', 'Service.run'],
        ['function', 'helper']
      ])
    )
    expect(parsed.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        moduleSpecifier: './dep',
        kind: 'import',
        bindings: [
          { localName: 'defaultFn', importedName: 'default' },
          { localName: 'callDep', importedName: 'depFn' }
        ]
      }),
      expect.objectContaining({ moduleSpecifier: './bridge', kind: 're_export' })
    ]))
    expect(parsed.exports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        exportedName: 'forwarded',
        importedName: 'remote',
        moduleSpecifier: './bridge'
      }),
      expect.objectContaining({ exportedName: 'Service', localName: 'Service' }),
      expect.objectContaining({ exportedName: 'helper', localName: 'helper' })
    ]))
    expect(parsed.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawTarget: 'callDep', bindingName: 'callDep' }),
      expect.objectContaining({ rawTarget: 'defaultFn', bindingName: 'defaultFn' })
    ]))
    expect(parsed.inheritance).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawTarget: 'LocalBase', kind: 'extends' }),
      expect.objectContaining({ rawTarget: 'Contract', kind: 'implements' })
    ]))
  })

  it('抽取 Python import、公开符号、继承和调用', async () => {
    const parsed = await registry.parse({
      path: 'pkg/service.py',
      language: 'python',
      source: `from .dep import work as run_work
import pkg.tools as tools

class Service(Base):
    def run(self):
        return run_work()

def helper():
    return tools.make()
`
    })

    expect(parsed.parseStatus).toBe('parsed')
    expect(parsed.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        moduleSpecifier: '.dep',
        bindings: [{ localName: 'run_work', importedName: 'work' }]
      }),
      expect.objectContaining({
        moduleSpecifier: 'pkg.tools',
        bindings: [{ localName: 'tools', importedName: null }]
      })
    ]))
    expect(parsed.symbols.map((symbol) => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ['class', 'Service'],
        ['method', 'Service.run'],
        ['function', 'helper']
      ])
    )
    expect(parsed.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawTarget: 'run_work', bindingName: 'run_work' }),
      expect.objectContaining({ rawTarget: 'tools.make', bindingName: 'tools' })
    ]))
    expect(parsed.inheritance).toContainEqual(
      expect.objectContaining({ rawTarget: 'Base', kind: 'extends' })
    )
  })

  it('语法错误显式标记 failed，不输出不可靠关系', async () => {
    const parsed = await registry.parse({
      path: 'src/broken.ts',
      language: 'typescript',
      source: 'export function broken( {'
    })

    expect(parsed.parseStatus).toBe('failed')
    expect(parsed.parseErrorCount).toBeGreaterThan(0)
    expect(parsed.symbols).toHaveLength(1)
    expect(parsed.imports).toEqual([])
    expect(parsed.calls).toEqual([])
  })

  it('七种首版扩展映射到固定 grammar，签名字节稳定', async () => {
    expect(registry.signature).toBe(TREE_SITTER_PARSER_SIGNATURE)
    const fixtures = [
      {
        language: 'typescript',
        source: 'export interface Item { value: number }\nexport type ItemId = string\n',
        symbol: ['interface', 'Item']
      },
      {
        language: 'tsx',
        source: 'type Props = { value: string }\nexport function View(props: Props) { return <div>{props.value}</div> }\n',
        symbol: ['function', 'View']
      },
      {
        language: 'javascript',
        source: 'export class Service { run() { return 1 } }\n',
        symbol: ['class', 'Service']
      },
      {
        language: 'jsx',
        source: 'export function View() { return <section data-kind="view" /> }\n',
        symbol: ['function', 'View']
      },
      {
        language: 'mjs',
        source: "import { value } from './dep.mjs'\nexport function run() { return value }\n",
        symbol: ['function', 'run']
      },
      {
        language: 'cjs',
        source: "const dep = require('./dep.cjs')\nconst run = function () { return dep.value }\nmodule.exports = run\n",
        symbol: ['constant', 'run']
      },
      {
        language: 'python',
        source: 'class Service:\n    def run(self):\n        return 1\n',
        symbol: ['class', 'Service']
      }
    ] as const
    for (const fixture of fixtures) {
      const parsed = await registry.parse({
        path: `src/file.${fixture.language}`,
        language: fixture.language,
        source: fixture.source
      })
      expect(parsed.parseStatus).toBe('parsed')
      expect(parsed.symbols.map((symbol) => [symbol.kind, symbol.name])).toContainEqual(
        fixture.symbol
      )
      if (fixture.language === 'mjs') {
        expect(parsed.imports).toContainEqual(expect.objectContaining({
          moduleSpecifier: './dep.mjs',
          kind: 'import'
        }))
      }
      if (fixture.language === 'cjs') {
        expect(parsed.imports).toContainEqual(expect.objectContaining({
          moduleSpecifier: './dep.cjs',
          kind: 'import'
        }))
        expect(parsed.exports).toContainEqual(expect.objectContaining({
          exportedName: 'default',
          localName: 'run'
        }))
      }
    }
  })

  it('grammar 资源缺失时显式失败，不切换其他解析路径', async () => {
    const parser = await TreeSitterParser.create({
      ...parserOptions,
      grammarWasmPaths: {
        ...parserOptions.grammarWasmPaths,
        python: resolve(grammarRoot, 'missing-python.wasm')
      }
    })

    await expect(parser.parse({
      path: 'src/file.py',
      language: 'python',
      source: 'value = 1\n'
    })).rejects.toMatchObject({ code: 'grammar_missing' })
  })
})
