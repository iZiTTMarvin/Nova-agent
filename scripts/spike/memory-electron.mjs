/**
 * Electron 运行时 FTS5 trigram 冒烟（Spike S0）。
 * 直接加载 node_modules 内按 Electron ABI 重编后的 better-sqlite3。
 * 用法：npm run spike:memory-electron
 */
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

function verify(dbPath) {
  const db = new Database(dbPath)
  const version = db.prepare('SELECT sqlite_version() AS v').get().v

  db.exec(`CREATE VIRTUAL TABLE spike_fts USING fts5(body, tokenize='trigram');`)
  db.prepare(`INSERT INTO spike_fts(body) VALUES (?)`).run(
    '跨会话记忆系统需要支持中文全文检索与子串召回。'
  )
  const row = db
    .prepare(`SELECT body FROM spike_fts WHERE body MATCH ? LIMIT 1`)
    .get('中文全文')

  db.close()

  const [major, minor] = version.split('.').map((n) => parseInt(n, 10))
  const meetsTrigram = major > 3 || (major === 3 && minor >= 34)
  const hit = row?.body?.includes('中文全文') === true

  // 持久化：重开同一文件再查
  const db2 = new Database(dbPath)
  const row2 = db2
    .prepare(`SELECT body FROM spike_fts WHERE body MATCH ? LIMIT 1`)
    .get('跨会话')
  db2.close()

  const persisted = row2?.body?.includes('跨会话') === true

  return { ok: meetsTrigram && hit && persisted, version, hit, persisted }
}

app.whenReady().then(() => {
  let tempDir = null
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-electron-spike-'))
    const dbPath = join(tempDir, 'spike.db')
    const result = verify(dbPath)
    console.log('[spike:memory-electron]', JSON.stringify(result, null, 2))
    app.exit(result.ok ? 0 : 1)
  } catch (err) {
    console.error('[spike:memory-electron] 异常:', err)
    app.exit(1)
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // 忽略
      }
    }
  }
})
