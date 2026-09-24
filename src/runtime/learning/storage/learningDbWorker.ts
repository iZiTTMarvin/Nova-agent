import { parentPort } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseLearningDbHostMessage, type LearningDbWorkerMessage } from './protocol'

const port = parentPort
if (!port) {
  throw new Error('learningDbWorker 必须以 worker_threads 方式启动')
}

const require = createRequire(fileURLToPath(import.meta.url))
import type BetterSqlite3 from 'better-sqlite3'

let db: BetterSqlite3.Database | null = null

function post(message: LearningDbWorkerMessage): void {
  port!.postMessage(message)
}

port.postMessage({ kind: 'ready' } satisfies LearningDbWorkerMessage)

port.on('message', (value: unknown) => {
  const message = parseLearningDbHostMessage(value)
  if (!message) {
    post({ kind: 'error', requestId: -1, message: '无效协议消息' })
    return
  }
  try {
    if (message.kind === 'open') {
      if (db) db.close()
      const Database = require('better-sqlite3') as typeof import('better-sqlite3')
      const opened = new Database(message.dbPath)
      opened.pragma('journal_mode = WAL')
      opened.pragma('foreign_keys = ON')
      db = opened
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
    if (message.kind === 'transaction') {
      if (!db) throw new Error('数据库未打开')
      const run = db.transaction(() => {
        for (const statement of message.statements) {
          db!.prepare(statement.sql).run(...(statement.params ?? []))
        }
      })
      run()
      post({ kind: 'ok', requestId: message.requestId })
    }
  } catch (error) {
    post({
      kind: 'error',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error)
    })
  }
})
