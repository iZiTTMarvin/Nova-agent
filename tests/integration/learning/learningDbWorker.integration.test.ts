import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { LearningDbWorkerClient } from '../../../src/runtime/learning/storage/LearningDbWorkerClient'

const workerJs = join(process.cwd(), 'out', 'main', 'learningDbWorker.js')

describe('learningDbWorker integration', () => {
  let tempDir: string

  afterEach(() => {
    if (!tempDir) return
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // Windows 上 WAL 句柄释放可能略滞后，不将清理失败误判为事务失败
    }
  })

  it('加载原生模块、执行事务、关闭后重开仍能读到已提交数据', async () => {
    if (!existsSync(workerJs)) {
      throw new Error(`缺少构建产物 ${workerJs}，请先 npm run build`)
    }
    tempDir = mkdtempSync(join(tmpdir(), 'nova-learning-db-'))
    const dbPath = join(tempDir, 'learning.db')

    const client = new LearningDbWorkerClient(workerJs)
    await client.start()
    await client.open(dbPath)
    await client.runTransaction([
      {
        sql: 'CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)'
      },
      { sql: 'INSERT INTO probe (value) VALUES (?)', params: ['batch-one'] }
    ])
    await client.close()

    const client2 = new LearningDbWorkerClient(workerJs)
    await client2.start()
    await client2.open(dbPath)
    await client2.runTransaction([
      { sql: 'INSERT INTO probe (value) VALUES (?)', params: ['batch-two'] }
    ])
    await client2.close()

    const Database = (await import('better-sqlite3')).default
    const row = new Database(dbPath).prepare('SELECT COUNT(*) AS c FROM probe').get() as {
      c: number
    }
    expect(row.c).toBe(2)
  }, 30_000)
})
