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
