/**
 * 打包冒烟专用最小 Electron 主进程：仅验证 asarUnpack 后 better-sqlite3 + FTS5 trigram。
 * 由 electron-builder.spike.yml 引用，产物为 portable exe。
 */
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'

function runPackSpike(): { ok: boolean; detail: Record<string, unknown> } {
  let tempDir: string | null = null
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-pack-spike-'))
    const dbPath = join(tempDir, 'pack-spike.db')

    const db = new Database(dbPath)
    const versionRow = db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    const version = versionRow.v

    db.exec(`
      CREATE VIRTUAL TABLE pack_spike_fts USING fts5(body, tokenize='trigram');
    `)
    db.prepare(`INSERT INTO pack_spike_fts(body) VALUES (?)`).run(
      '打包产物内需能加载 FTS5 trigram 并检索中文。'
    )
    const row = db
      .prepare(`SELECT body FROM pack_spike_fts WHERE body MATCH ? LIMIT 1`)
      .get('中文') as { body: string } | undefined

    db.close()

    const hit = row?.body?.includes('中文') === true
    const [major, minor] = version.split('.').map((n) => parseInt(n, 10))
    const meetsTrigram =
      major > 3 || (major === 3 && (minor ?? 0) >= 34)

    return {
      ok: hit && meetsTrigram,
      detail: { sqliteVersion: version, trigramHit: hit, meetsTrigram }
    }
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // 忽略
      }
    }
  }
}

app.whenReady().then(() => {
  try {
    const result = runPackSpike()
    console.log('[pack-spike]', JSON.stringify(result, null, 2))
    // 用 process.exit 确保子进程可被 spawnSync 及时回收（app.exit 偶发挂起）
    process.exit(result.ok ? 0 : 1)
  } catch (err) {
    console.error('[pack-spike] 异常:', err)
    process.exit(1)
  }
})

// 兜底：15s 内未退出则判定失败
setTimeout(() => {
  console.error('[pack-spike] 超时未退出')
  process.exit(1)
}, 15_000)
