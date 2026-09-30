import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 小型记账流程 fixture：保存 → 校验 → 写入。 */
export function writeLedgerFixture(root: string): {
  readonly savePath: string
  readonly unreadPath: string
} {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'ledger-demo', description: '个人记账演示' }, null, 2),
    'utf8'
  )
  writeFileSync(
    join(root, 'README.md'),
    '# Ledger\n\n演示项目。\n',
    'utf8'
  )
  const savePath = 'src/save.ts'
  writeFileSync(
    join(root, savePath),
    `export function validateEntry(input: { amount: number; note: string }) {
  if (!Number.isFinite(input.amount)) throw new Error('invalid amount')
  if (!input.note.trim()) throw new Error('empty note')
  return { ...input, note: input.note.trim() }
}

export function persistEntry(entry: { amount: number; note: string }) {
  const line = JSON.stringify(entry)
  return { ok: true, bytes: line.length }
}
`,
    'utf8'
  )
  writeFileSync(
    join(root, 'src/index.ts'),
    `import { validateEntry, persistEntry } from './save'

export function saveUserEntry(raw: { amount: number; note: string }) {
  const entry = validateEntry(raw)
  return persistEntry(entry)
}
`,
    'utf8'
  )
  const unreadPath = 'src/unread.ts'
  writeFileSync(
    join(root, unreadPath),
    'export const neverRead = true\n',
    'utf8'
  )
  mkdirSync(join(root, 'src', 'filler'), { recursive: true })
  for (let i = 0; i < 30; i++) {
    writeFileSync(
      join(root, 'src', 'filler', `file-${i}.ts`),
      `export const v${i} = ${i}\n`,
      'utf8'
    )
  }
  return { savePath, unreadPath }
}


/**
 * 约 1500 个文件的中型项目：src 下 8 个模块目录，每个文件带头注释与 import 区，
 * 另有 tests/ 与样式文件，用于验证装箱预算、分散覆盖与片段起点。
 */
export function writeLargeProjectFixture(root: string): void {
  const modules = ['agent', 'model', 'tools', 'sessions', 'storage', 'ui', 'ipc', 'workspace']
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'large-demo', main: './src/index.ts' }, null, 2), 'utf8')
  writeFileSync(join(root, 'README.md'), '# Large demo\n\nA fixture project.\n', 'utf8')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'),
    modules.map(m => `import { start${m} } from './${m}/file-0'`).join('\n') + '\n\nexport function main() {\n  return 1\n}\n', 'utf8')
  const body = (module: string, i: number): string => [
    '/**',
    ` * ${module} 模块第 ${i} 个文件。`,
    ' */',
    `import { helper } from './file-${(i + 1) % 180}'`,
    "import type { Config } from '../model/file-0'",
    '',
    `export function start${i === 0 ? module : `${module}${i}`}(config?: Config) {`,
    ...Array.from({ length: 60 }, (_, line) => `  const value${line} = helper(${line}) + ${i}`),
    '  return config',
    '}',
    ''
  ].join('\n')
  for (const module of modules) {
    mkdirSync(join(root, 'src', module), { recursive: true })
    for (let i = 0; i < 180; i++) {
      writeFileSync(join(root, 'src', module, `file-${i}.ts`), body(module, i), 'utf8')
    }
  }
  mkdirSync(join(root, 'tests'), { recursive: true })
  for (let i = 0; i < 40; i++) {
    writeFileSync(join(root, 'tests', `case-${i}.test.ts`), "import { main } from '../src/index'\nmain()\n", 'utf8')
  }
  mkdirSync(join(root, 'styles'), { recursive: true })
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(root, 'styles', `theme-${i}.css`), `.c${i} { color: red; }\n`, 'utf8')
  }
}
