import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseLearningDbHostMessage, type LearningDbWorkerMessage } from './protocol'
import { assertLearningDbPathAllowed } from './dbPathPolicy'
import { migrateLearningDatabase, assertLearningDatabaseWritable } from './migrations'
import { parseLearningDbWorkerOp } from './workerCommand'
import { executeLearningDbWorkerOp } from './workerExecutor'

const port = parentPort
if (!port) {
  throw new Error('learningDbWorker 必须以 worker_threads 方式启动')
}

const require = createRequire(fileURLToPath(import.meta.url))
import type BetterSqlite3 from 'better-sqlite3'

let db: BetterSqlite3.Database | null = null
const initialization: unknown = workerData
const userLearningRoot = initialization && typeof initialization === 'object' &&
  'userLearningRoot' in initialization && typeof initialization.userLearningRoot === 'string'
  ? initialization.userLearningRoot : null

function post(message: LearningDbWorkerMessage): void {
  port!.postMessage(message)
}

port.postMessage({ kind: 'ready' } satisfies LearningDbWorkerMessage)

port.on('message', (value: unknown) => {
  const message = parseLearningDbHostMessage(value)
  if (!message) {
    post({ kind: 'error', requestId: -1, message: '无效协议消息', code: 'invalid' })
    return
  }
  try {
    if (message.kind === 'open') {
      assertLearningDbPathAllowed(message.dbPath, userLearningRoot)
      if (db) db.close()
      const Database = require('better-sqlite3') as typeof import('better-sqlite3')
      const opened = new Database(message.dbPath)
      opened.pragma('journal_mode = WAL')
      opened.pragma('foreign_keys = ON')
      try {
        migrateLearningDatabase(opened)
        db = opened
      } catch (error) {
        opened.close()
        throw error
      }
      post({ kind: 'ok', requestId: message.requestId })
      return
    }
    if (message.kind === 'close') {
      if (db) {
        db.pragma('wal_checkpoint(FULL)')
        db.close()
      }
      db = null
      post({ kind: 'ok', requestId: message.requestId })
      return
    }
    if (message.kind === 'invoke') {
      if (!db) throw new Error('数据库未打开')
      assertLearningDatabaseWritable(db)
      const op = parseLearningDbWorkerOp(message.command)
      const run = db.transaction(() => executeLearningDbWorkerOp(db!, op))
      const outcome = run()
      if (!outcome.ok) {
        post({
          kind: 'error',
          requestId: message.requestId,
          message: outcome.message,
          code: 'exec'
        })
        return
      }
      post({ kind: 'ok', requestId: message.requestId, result: outcome.result })
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const code =
      error instanceof Error && error.name === 'LearningSchemaFutureError'
        ? 'future_schema'
        : 'error'
    post({ kind: 'error', requestId: message.requestId, message: msg, code })
  }
})
