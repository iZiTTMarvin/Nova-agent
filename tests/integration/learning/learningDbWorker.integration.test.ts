import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { LearningDbWorkerClient } from '../../../src/runtime/learning/storage/LearningDbWorkerClient'
import {
  CURRENT_LEARNING_SCHEMA_VERSION,
  learningSchemaV1Statements
} from '../../../src/runtime/learning/storage/schema'
import { LearningProgress } from '../../../src/runtime/learning/progress/LearningProgress'
import { LearningProgressRepository } from '../../../src/runtime/learning/progress/LearningProgressRepository'
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

  it('宿主声明的用户学习目录可以打开数据库', async () => {
    if (!existsSync(learningWorkerJs)) {
      throw new Error(`缺少构建产物 ${learningWorkerJs}，请先 npm run build`)
    }
    // 普通用户目录（如 userData/learning）不是临时目录；
    // 必须经初始化契约传入后可用，否则真实应用启动即失败
    tempDir = mkdtempSync(join(process.cwd(), 'nova-learning-userroot-'))
    const client = new LearningDbWorkerClient(learningWorkerJs, tempDir)
    await client.start()
    const dbPath = join(tempDir, 'learning.db')
    await client.open(dbPath)
    const progress = new LearningProgress(
      new LearningProgressRepository(client)
    )
    await progress.saveCheckpoint({
      workspaceRoot: join(tempDir, 'ws'),
      sessionId: 'sess-user-root',
      runId: 'run-1',
      checkpointId: 'ckpt-user-root',
      cursorVersion: 0,
      question: 'Q?',
      rubricJson:
        '{"targetClaim":"t","knowledgeRevision":null,"verificationMethod":"open","criteria":"c"}'
    })
    const loaded = await progress.getCheckpointForSession('sess-user-root')
    expect(loaded?.checkpointId).toBe('ckpt-user-root')
    await client.close()
  }, 30_000)

  it('旧 schema 库逐级升级到当前版本，不停在半迁移状态', async () => {
    if (!existsSync(learningWorkerJs)) {
      throw new Error(`缺少构建产物 ${learningWorkerJs}，请先 npm run build`)
    }
    tempDir = mkdtempSync(join(tmpdir(), 'nova-learning-db-'))
    const dbPath = join(tempDir, 'legacy.db')

    // 手工构造 v1 库：只有初始 DDL，schema_meta 记 1
    const Database = (await import('better-sqlite3')).default
    const legacy = new Database(dbPath)
    for (const sql of learningSchemaV1Statements()) {
      legacy.exec(sql)
    }
    legacy
      .prepare(`INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')`)
      .run()
    legacy.close()

    const harness = await createLearningDbHarness(dbPath)
    await harness.close()

    const upgraded = new Database(dbPath)
    const version = upgraded
      .prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
      .get() as { value: string }
    expect(Number.parseInt(version.value, 10)).toBe(CURRENT_LEARNING_SCHEMA_VERSION)
    // v3 的停点判据列与 v4 的观察索引都应在升级后存在
    const checkpointColumns = upgraded
      .prepare(`PRAGMA table_info(checkpoints)`)
      .all()
      .map((row: Record<string, unknown>) => String(row.name))
    expect(checkpointColumns).toContain('rubric_json')
    expect(checkpointColumns).toContain('node_id')
    const checkpointIndexes = upgraded
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='checkpoints'`)
      .all()
      .map((row: Record<string, unknown>) => String(row.name))
    expect(checkpointIndexes).toContain('idx_checkpoints_project_node')
    const observationIndexes = upgraded
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='learning_observations'`
      )
      .all()
      .map((row: Record<string, unknown>) => String(row.name))
    expect(observationIndexes).toContain('idx_learning_observations_session_kind')
    upgraded.close()
  }, 30_000)
})
