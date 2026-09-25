import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { LearningDbWorkerClient } from '../../../src/runtime/learning/storage/LearningDbWorkerClient'
import { CURRENT_LEARNING_SCHEMA_VERSION } from '../../../src/runtime/learning/storage/schema'
import { createLearningDbHarness, learningWorkerJs } from './learningTestHarness'

describe('learningDbWorker integration', () => {
  let tempDir: string

  afterEach(() => {
    if (!tempDir) return
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // Windows 上 WAL 句柄释放可能略滞后
    }
  })

  it('加载原生模块、迁移 schema、ACK 后重开可恢复游标', async () => {
    if (!existsSync(learningWorkerJs)) {
      throw new Error(`缺少构建产物 ${learningWorkerJs}，请先 npm run build`)
    }
    tempDir = mkdtempSync(join(tmpdir(), 'nova-learning-db-'))
    const dbPath = join(tempDir, 'learning.db')
    const workspace = join(tempDir, 'ws')

    const harness = await createLearningDbHarness(dbPath)
    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId: 'sess-1',
      runId: 'run-1',
      checkpointId: 'ckpt-1',
      cursorVersion: 0,
      question: 'Q?',
      rubricJson:
        '{"targetClaim":"t","knowledgeRevision":null,"verificationMethod":"open","criteria":"c"}'
    })
    await harness.close()

    const harness2 = await createLearningDbHarness(dbPath)
    const loaded = await harness2.progress.getCheckpointForSession('sess-1')
    expect(loaded?.checkpointId).toBe('ckpt-1')
    await harness2.close()

    const Database = (await import('better-sqlite3')).default
    const version = new Database(dbPath)
      .prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
      .get() as { value: string }
    expect(Number.parseInt(version.value, 10)).toBe(CURRENT_LEARNING_SCHEMA_VERSION)
  }, 30_000)

  it('拒绝非临时目录的数据库路径', async () => {
    if (!existsSync(learningWorkerJs)) {
      throw new Error(`缺少构建产物 ${learningWorkerJs}，请先 npm run build`)
    }
    tempDir = mkdtempSync(join(tmpdir(), 'nova-learning-db-'))
    const client = new LearningDbWorkerClient(learningWorkerJs)
    await client.start()
    await expect(client.open(join(process.cwd(), 'learning-forbidden.db'))).rejects.toThrow(
      /临时或测试目录/
    )
    await client.close()
  }, 30_000)
})
