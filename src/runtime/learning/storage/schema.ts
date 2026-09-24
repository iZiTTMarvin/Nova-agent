/** 学习库 schema 版本；与 SessionStore 独立版本化。 */
export const CURRENT_LEARNING_SCHEMA_VERSION = 1

export const LEARNING_SCHEMA_META_KEY = 'schema_version'

/** v1 初始 DDL，在单事务内应用。 */
export function learningSchemaV1Statements(): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY NOT NULL,
      workspace_path TEXT NOT NULL,
      workspace_path_hash TEXT NOT NULL UNIQUE,
      clear_generation INTEGER NOT NULL DEFAULT 0,
      current_knowledge_revision TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS knowledge_versions (
      project_id TEXT NOT NULL,
      knowledge_revision TEXT NOT NULL,
      parent_revision TEXT,
      input_fingerprint TEXT NOT NULL,
      coverage_json TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, knowledge_revision),
      FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS node_versions (
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_revision TEXT NOT NULL,
      title TEXT NOT NULL,
      body_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, node_id, node_revision),
      FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS version_members (
      project_id TEXT NOT NULL,
      knowledge_revision TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_revision TEXT NOT NULL,
      PRIMARY KEY (project_id, knowledge_revision, node_id),
      FOREIGN KEY (project_id, knowledge_revision)
        REFERENCES knowledge_versions(project_id, knowledge_revision) ON DELETE CASCADE,
      FOREIGN KEY (project_id, node_id, node_revision)
        REFERENCES node_versions(project_id, node_id, node_revision) ON DELETE RESTRICT
    )`,
    `CREATE TABLE IF NOT EXISTS knowledge_edges (
      project_id TEXT NOT NULL,
      knowledge_revision TEXT NOT NULL,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      edge_kind TEXT NOT NULL,
      PRIMARY KEY (project_id, knowledge_revision, from_node_id, to_node_id, edge_kind),
      FOREIGN KEY (project_id, knowledge_revision)
        REFERENCES knowledge_versions(project_id, knowledge_revision) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS source_receipts (
      receipt_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS node_sources (
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_revision TEXT NOT NULL,
      receipt_id TEXT NOT NULL,
      PRIMARY KEY (project_id, node_id, node_revision, receipt_id),
      FOREIGN KEY (project_id, node_id, node_revision)
        REFERENCES node_versions(project_id, node_id, node_revision) ON DELETE CASCADE,
      FOREIGN KEY (receipt_id) REFERENCES source_receipts(receipt_id) ON DELETE RESTRICT
    )`,
    `CREATE TABLE IF NOT EXISTS learning_cursors (
      session_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      cursor_version INTEGER NOT NULL DEFAULT 0,
      selected_node_id TEXT,
      knowledge_revision TEXT,
      current_checkpoint_id TEXT,
      clear_generation INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS checkpoints (
      checkpoint_id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      cursor_version INTEGER NOT NULL,
      question TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'awaiting_answer','answer_pending','answered','skipped','superseded'
      )),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES learning_cursors(session_id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS attempts (
      attempt_id TEXT PRIMARY KEY NOT NULL,
      checkpoint_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      answer_excerpt TEXT,
      source_message_ref TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(checkpoint_id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS learning_observations (
      observation_id TEXT PRIMARY KEY NOT NULL,
      attempt_id TEXT,
      checkpoint_id TEXT,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS learning_commands (
      command_id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      clear_generation INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS outbox (
      outbox_id TEXT PRIMARY KEY NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','delivered','cancelled')),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (command_id) REFERENCES learning_commands(command_id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS knowledge_builds (
      build_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      knowledge_revision TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_versions_project
      ON knowledge_versions(project_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_learning_cursors_project
      ON learning_cursors(project_id, session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_checkpoints_session
      ON checkpoints(session_id, state)`,
    `CREATE INDEX IF NOT EXISTS idx_checkpoints_project
      ON checkpoints(project_id, session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_learning_commands_session
      ON learning_commands(session_id, command_id)`,
    `CREATE INDEX IF NOT EXISTS idx_outbox_session
      ON outbox(session_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_node_versions_project
      ON node_versions(project_id, node_id)`,
    `CREATE INDEX IF NOT EXISTS idx_source_receipts_project_path
      ON source_receipts(project_id, file_path)`
  ]
}
