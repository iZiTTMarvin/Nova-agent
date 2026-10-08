CREATE TABLE memory_records (
      id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      memory_key TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      explicitness TEXT NOT NULL,
      source_type TEXT NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      supersedes_id TEXT,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      distinct_session_count INTEGER NOT NULL DEFAULT 1,
      distinct_project_count INTEGER NOT NULL DEFAULT 1,
      source_path TEXT,
      source_fingerprint TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      metadata_json TEXT
    );
CREATE TABLE memory_evidence (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, session_id TEXT, message_id TEXT, project_scope_id TEXT, evidence_type TEXT NOT NULL, excerpt TEXT, created_at INTEGER NOT NULL);
PRAGMA user_version = 2;
