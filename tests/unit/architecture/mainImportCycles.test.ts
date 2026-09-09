import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  extractModuleSpecifiers,
  findRepoRoot,
  listSrcTypeScriptFiles,
  resolveModuleSpecifier
} from './importBoundaryScanner'

function findCycles(sources: ReadonlyMap<string, string>): string[][] {
  const edges = new Map<string, string[]>()
  for (const [file, source] of sources) {
    const dependencies: string[] = []
    for (const { specifier } of extractModuleSpecifiers(source, file, true).specifiers) {
      const resolved = resolveModuleSpecifier(file, specifier, target => sources.has(target))
      if (resolved.kind === 'resolved') dependencies.push(resolved.path)
    }
    edges.set(file, dependencies)
  }
  const visited = new Set<string>()
  const stack: string[] = []
  const active = new Map<string, number>()
  const cycles: string[][] = []
  const visit = (file: string): void => {
    const index = active.get(file)
    if (index !== undefined) {
      cycles.push([...stack.slice(index), file])
      return
    }
    if (visited.has(file)) return
    visited.add(file)
    active.set(file, stack.length)
    stack.push(file)
    for (const target of edges.get(file) ?? []) visit(target)
    stack.pop()
    active.delete(file)
  }
  for (const file of sources.keys()) visit(file)
  return cycles
}

describe('main 静态 value-import 无循环', () => {
  it('扫描所有 main 文件，包括 barrel 重导出，不使用循环 allowlist', () => {
    const root = findRepoRoot()
    const sources = new Map(listSrcTypeScriptFiles(root)
      .filter(file => file.startsWith('src/main/'))
      .map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]))
    expect(sources.size).toBeGreaterThan(0)
    expect(findCycles(sources)).toEqual([])
  })

  it('识别经过 alias、目录 barrel、具名和星号重导出的加载环', () => {
    const sources = new Map([
      ['src/main/service.ts', "import { run } from '@main/turn'; export const service = run"],
      ['src/main/turn/index.ts', "export * from './turn'"],
      ['src/main/turn/turn.ts', "export { service as run } from '../service'"]
    ])
    expect(findCycles(sources)).toEqual([[
      'src/main/service.ts', 'src/main/turn/index.ts',
      'src/main/turn/turn.ts', 'src/main/service.ts'
    ]])
  })

  it('排除声明级和行内 type-only 依赖，但不丢失混合导入中的 value', () => {
    const source = `
      import type { A } from './a'
      import { type A } from './a'
      export type { A } from './a'
      export { type A } from './a'
      export type * from './a'
      type A = import('./a').A
      import { type B, value } from './b'
      export { type B, value } from './b'
      import './side-effect'
      export * as namespace from './namespace'
    `
    expect(extractModuleSpecifiers(source, 'virtual.ts', true).specifiers).toEqual([
      { specifier: './b', kind: 'import' },
      { specifier: './b', kind: 'export-from' },
      { specifier: './side-effect', kind: 'import' },
      { specifier: './namespace', kind: 'export-from' }
    ])
    expect(findCycles(new Map([
      ['src/main/a.ts', "import type { B } from './b'; export interface A {}"],
      ['src/main/b.ts', "export { type A as B } from './a'"]
    ]))).toEqual([])
  })
})
