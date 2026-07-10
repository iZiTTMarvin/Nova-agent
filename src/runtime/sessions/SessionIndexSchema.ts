/**
 * 会话消息派生索引 DDL（messages-index.sqlite）
 *
 * 仅存 offset/length/parentId/activeDepth 等索引字段，不含消息正文。
 * messages.jsonl 永远是事实源；本库可随时删除重建。
 */
import type { MemoryDb } from '../memory/MemoryDb'

/** 会话目录下的 SQLite 索引文件名 */
export const SESSION_INDEX_DB_FILE = 'messages-index.sqlite'

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS message_index (
  messageId TEXT PRIMARY KEY,
  parentId TEXT,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  activeDepth INTEGER,
  indexedFileSize INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_active_depth ON message_index(activeDepth);
CREATE INDEX IF NOT EXISTS idx_parent ON message_index(parentId);

CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** 初始化会话索引表结构（幂等） */
export function initSessionIndexSchema(db: MemoryDb): void {
  db.exec(SCHEMA_SQL)
}
