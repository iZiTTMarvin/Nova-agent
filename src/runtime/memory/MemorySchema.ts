/**
 * 记忆索引 DDL：memory_files 内容表 + memory_fts trigram FTS5 虚表 + 同步触发器。
 * 仅依赖 MemoryDb 端口，集成测试在 BetterSqliteMemoryDb 上验证。
 */
import type { MemoryDb } from './MemoryDb'

/** memory_files 上 (scope_id, rel_path) 唯一索引；勿命名为 memory_fts_idx（FTS5 阴影表占用） */
export const MEMORY_FILES_SCOPE_PATH_IDX = 'memory_files_scope_path_uidx'

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS memory_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  body TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_files_scope_path_uidx ON memory_files(scope_id, rel_path);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  body,
  scope_id UNINDEXED,
  rel_path UNINDEXED,
  content='memory_files',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memory_files_ai AFTER INSERT ON memory_files BEGIN
  INSERT INTO memory_fts(rowid, body, scope_id, rel_path)
  VALUES (new.id, new.body, new.scope_id, new.rel_path);
END;

CREATE TRIGGER IF NOT EXISTS memory_files_ad AFTER DELETE ON memory_files BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, body, scope_id, rel_path)
  VALUES ('delete', old.id, old.body, old.scope_id, old.rel_path);
END;

CREATE TRIGGER IF NOT EXISTS memory_files_au AFTER UPDATE ON memory_files BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, body, scope_id, rel_path)
  VALUES ('delete', old.id, old.body, old.scope_id, old.rel_path);
  INSERT INTO memory_fts(rowid, body, scope_id, rel_path)
  VALUES (new.id, new.body, new.scope_id, new.rel_path);
END;
`

/**
 * 初始化记忆库表结构（幂等）
 * @param db 已打开的 MemoryDb
 */
export function initMemorySchema(db: MemoryDb): void {
  db.exec(SCHEMA_SQL)
}

/** 列出 sqlite_master 中记忆相关对象（供集成测试断言） */
export function listMemorySchemaObjects(db: MemoryDb): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE name IN ('memory_files', 'memory_fts', 'memory_fts_idx', 'memory_files_scope_path_uidx')
          OR name LIKE 'memory_files_a%'
       ORDER BY name`
    )
    .all<{ name: string }>()
  return rows.map((r) => r.name)
}
