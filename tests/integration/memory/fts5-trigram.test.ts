/**
 * FTS5 trigram 集成测试：加载为当前 Node ABI 编译的 better-sqlite3。
 * 仅通过 npm run test:memory-integration 执行，不进 npm test 默认套件。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { BetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { verifyTrigramFts5 } from '@runtime/memory/spikeVerify'

describe('FTS5 trigram 集成（better-sqlite3 @ Node ABI）', () => {
  let tempDir: string | null = null

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  it('中文正文 + 中文子串 query 可 trigram 召回，且文件持久化后可重开', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-memory-spike-'))
    const dbPath = join(tempDir, 'memory.db')

    const db = new BetterSqliteMemoryDb(dbPath)
    const result = verifyTrigramFts5(db, () => new BetterSqliteMemoryDb(dbPath))

    expect(result.ok).toBe(true)
    expect(result.sqliteMeetsTrigram).toBe(true)
    expect(result.sqliteVersion).toMatch(/^\d+\.\d+/)
    expect(result.trigramMatchHit).toBe(true)
    expect(result.persistedAfterReopen).toBe(true)
    if (result.errors.length > 0) {
      throw new Error(result.errors.join('; '))
    }
  })
})
