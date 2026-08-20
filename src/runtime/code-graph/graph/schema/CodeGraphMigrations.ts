import type Database from 'better-sqlite3'

export const CODE_GRAPH_SCHEMA_VERSION = 1

export type CodeGraphMigrationFailureCode = 'newer-version' | 'step-failed'

export interface CodeGraphMigrationDiagnostic {
  readonly code: CodeGraphMigrationFailureCode
  readonly fromVersion: number
  readonly targetVersion: number
  readonly failedStep: number | null
  readonly failedStatement: string | null
  readonly message: string
}

export class CodeGraphMigrationError extends Error {
  readonly diagnostic: CodeGraphMigrationDiagnostic

  constructor(diagnostic: CodeGraphMigrationDiagnostic) {
    super(diagnostic.message)
    this.name = 'CodeGraphMigrationError'
    this.diagnostic = diagnostic
  }
}

export interface CodeGraphMigrationResult {
  readonly fromVersion: number
  readonly toVersion: number
  readonly appliedVersions: readonly number[]
}

interface CodeGraphMigrationStep {
  readonly version: number
  readonly statements: readonly string[]
}

const V1_STATEMENTS: readonly string[] = [
  `CREATE TABLE index_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  workspace_identity TEXT NOT NULL,
  active_generation INTEGER,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  parser_signature TEXT NOT NULL,
  resolver_signature TEXT NOT NULL,
  last_completed_at INTEGER,
  last_accessed INTEGER NOT NULL,
  write_operation_id TEXT,
  write_operation_kind TEXT CHECK (write_operation_kind IS NULL OR write_operation_kind IN ('full-rebuild', 'incremental-update')),
  write_generation INTEGER CHECK (write_generation IS NULL OR write_generation > 0),
  write_base_generation INTEGER,
  write_base_revision INTEGER CHECK (write_base_revision IS NULL OR write_base_revision >= 0)
)`,
  `CREATE TABLE generations (
  generation INTEGER PRIMARY KEY CHECK (generation > 0),
  operation_id TEXT NOT NULL,
  workspace_identity TEXT NOT NULL,
  parser_signature TEXT NOT NULL,
  resolver_signature TEXT NOT NULL,
  staged_at INTEGER NOT NULL
)`,
  `CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generation INTEGER NOT NULL REFERENCES generations(generation) ON DELETE CASCADE,
  path TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('typescript', 'tsx', 'javascript', 'jsx', 'mjs', 'cjs', 'python', 'unsupported')),
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mtime_ms INTEGER NOT NULL,
  line_count INTEGER NOT NULL CHECK (line_count >= 0),
  parse_status TEXT NOT NULL CHECK (parse_status IN ('parsed', 'failed', 'unsupported', 'skipped_too_large')),
  UNIQUE(generation, path)
)`,
  `CREATE TABLE symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generation INTEGER NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  stable_id TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('module', 'class', 'interface', 'function', 'method', 'constructor', 'property', 'variable', 'constant', 'type', 'enum', 'enum_member')),
  exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
  signature TEXT,
  doc_excerpt TEXT CHECK (doc_excerpt IS NULL OR length(doc_excerpt) <= 512),
  identifier_tokens TEXT NOT NULL,
  start_line INTEGER NOT NULL CHECK (start_line > 0),
  end_line INTEGER NOT NULL CHECK (end_line >= start_line),
  start_byte INTEGER NOT NULL CHECK (start_byte >= 0),
  end_byte INTEGER NOT NULL CHECK (end_byte >= start_byte),
  UNIQUE(generation, stable_id)
)`,
  `CREATE TABLE file_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generation INTEGER NOT NULL,
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  target_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('imports', 're_exports', 'test_of')),
  confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'probable', 'heuristic')),
  resolver TEXT NOT NULL CHECK (resolver IN ('structural', 'relative-path', 'tsconfig-paths', 'index-re-export', 'python-import', 'test-convention')),
  source_line INTEGER NOT NULL CHECK (source_line > 0),
  UNIQUE(generation, source_file_id, target_file_id, kind, source_line)
)`,
  `CREATE TABLE symbol_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generation INTEGER NOT NULL,
  source_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  target_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('calls', 'references', 'extends', 'implements', 'overrides')),
  confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'probable', 'heuristic')),
  resolver TEXT NOT NULL CHECK (resolver IN ('structural', 'relative-path', 'tsconfig-paths', 'index-re-export', 'python-import', 'test-convention')),
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL CHECK (source_line > 0),
  UNIQUE(generation, source_symbol_id, target_symbol_id, kind, source_line)
)`,
  `CREATE TABLE unresolved_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generation INTEGER NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('imports', 're_exports', 'test_of', 'calls', 'references', 'extends', 'implements', 'overrides')),
  raw_target TEXT NOT NULL,
  module_specifier TEXT,
  source_line INTEGER NOT NULL CHECK (source_line > 0),
  reason TEXT NOT NULL,
  resolver TEXT NOT NULL CHECK (resolver IN ('structural', 'relative-path', 'tsconfig-paths', 'index-re-export', 'python-import', 'test-convention'))
)`,
  `CREATE VIRTUAL TABLE symbol_fts USING fts5(
  symbol_id UNINDEXED,
  generation UNINDEXED,
  name,
  qualified_name,
  path,
  signature,
  short_doc,
  identifier_tokens,
  tokenize='unicode61'
)`,
  `CREATE INDEX files_generation_path_idx ON files(generation, path)`,
  `CREATE INDEX symbols_generation_name_idx ON symbols(generation, name)`,
  `CREATE INDEX symbols_file_idx ON symbols(file_id)`,
  `CREATE INDEX file_edges_generation_source_idx ON file_edges(generation, source_file_id)`,
  `CREATE INDEX file_edges_generation_target_idx ON file_edges(generation, target_file_id)`,
  `CREATE INDEX symbol_edges_generation_source_idx ON symbol_edges(generation, source_symbol_id)`,
  `CREATE INDEX symbol_edges_generation_target_idx ON symbol_edges(generation, target_symbol_id)`,
  `CREATE INDEX unresolved_generation_file_idx ON unresolved_relations(generation, file_id)`
]

const MIGRATION_STEPS: readonly CodeGraphMigrationStep[] = [
  { version: 1, statements: V1_STATEMENTS }
]

export function readCodeGraphSchemaVersion(db: Database.Database): number {
  const row = db.prepare('PRAGMA user_version').get()
  if (!isRecord(row) || typeof row.user_version !== 'number') {
    throw new Error('无法读取 Code Graph schema 版本')
  }
  return row.user_version
}

export function migrateCodeGraphSchema(db: Database.Database): CodeGraphMigrationResult {
  const fromVersion = readCodeGraphSchemaVersion(db)
  if (fromVersion > CODE_GRAPH_SCHEMA_VERSION) {
    throw new CodeGraphMigrationError({
      code: 'newer-version',
      fromVersion,
      targetVersion: CODE_GRAPH_SCHEMA_VERSION,
      failedStep: null,
      failedStatement: null,
      message: `Code Graph schema ${fromVersion} 高于当前支持的 ${CODE_GRAPH_SCHEMA_VERSION}`
    })
  }

  const appliedVersions: number[] = []
  for (const step of MIGRATION_STEPS) {
    if (step.version <= fromVersion) continue
    applyStep(db, step, fromVersion)
    appliedVersions.push(step.version)
  }

  return {
    fromVersion,
    toVersion: readCodeGraphSchemaVersion(db),
    appliedVersions
  }
}

function applyStep(
  db: Database.Database,
  step: CodeGraphMigrationStep,
  fromVersion: number
): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const statement of step.statements) {
      try {
        db.exec(statement)
      } catch (error) {
        throw new CodeGraphMigrationError({
          code: 'step-failed',
          fromVersion,
          targetVersion: CODE_GRAPH_SCHEMA_VERSION,
          failedStep: step.version,
          failedStatement: statement.slice(0, 120),
          message: `Code Graph schema 迁移到 v${step.version} 失败：${errorMessage(error)}`
        })
      }
    }
    db.exec(`UPDATE index_meta SET schema_version = ${step.version}`)
    db.exec(`PRAGMA user_version = ${step.version}`)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 保留原始迁移错误。
    }
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
