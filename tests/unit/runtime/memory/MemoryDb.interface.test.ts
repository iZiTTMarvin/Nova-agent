/**
 * MemoryDb 端口契约单测：使用内存 mock，不加载 better-sqlite3。
 */
import { describe, it, expect } from 'vitest'
import type { MemoryDb, MemoryDbStatement } from '@runtime/memory/MemoryDb'
import { verifyTrigramFts5 } from '@runtime/memory/spikeVerify'

/** 最小 in-memory mock，仅满足 spike 验证 SQL 路径 */
function createMockMemoryDb(): MemoryDb {
  const rows: string[] = []

  const insertStmt: MemoryDbStatement = {
    run: (...params: unknown[]) => {
      rows.push(String(params[0]))
      return { changes: 1 }
    },
    get: () => undefined,
    all: () => []
  }

  const matchStmt: MemoryDbStatement = {
    run: () => ({ changes: 0 }),
    get: <T>(query: unknown) => {
      const q = String(query)
      const hit = rows.find((r) => r.includes(q))
      return hit ? ({ body: hit } as T) : undefined
    },
    all: () => []
  }

  const versionStmt: MemoryDbStatement = {
    run: () => ({ changes: 0 }),
    get: <T>() => ({ v: '3.45.1' } as T),
    all: () => []
  }

  const statements = new Map<string, MemoryDbStatement>([
    [`INSERT INTO spike_fts(body) VALUES (?)`, insertStmt],
    [`SELECT body FROM spike_fts WHERE body MATCH ? LIMIT 1`, matchStmt],
    [`SELECT sqlite_version() AS v`, versionStmt]
  ])

  return {
    sqliteVersion: '3.45.1',
    exec: (sql: string) => {
      if (sql.includes('CREATE VIRTUAL TABLE')) return
      if (sql.includes('DELETE FROM spike_fts')) {
        rows.length = 0
        return
      }
      throw new Error(`mock 未实现 exec: ${sql}`)
    },
    prepare: (sql: string) => {
      const stmt = statements.get(sql.trim())
      if (!stmt) throw new Error(`mock 未实现 prepare: ${sql}`)
      return stmt
    },
    close: () => {}
  }
}

describe('MemoryDb 端口（mock，无原生模块）', () => {
  it('verifyTrigramFts5 在 mock 上应通过中文子串 MATCH', () => {
    const db = createMockMemoryDb()
    const result = verifyTrigramFts5(db)
    expect(result.ok).toBe(true)
    expect(result.sqliteMeetsTrigram).toBe(true)
    expect(result.trigramMatchHit).toBe(true)
  })
})
