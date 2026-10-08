import { SCOPE_KINDS, MEMORY_KINDS, MEMORY_STATUSES, EXPLICITNESS_LEVELS, MEMORY_EVIDENCE_TYPES, type MemoryRecord, type MemoryEvidence } from '../types'

// 行 → 领域对象的唯一权威转换：DB 行先按 unknown 接收，逐字段校验后产出。

function asRow(row: unknown, source: string): Record<string, unknown> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new Error(`${source} 行格式非法：期望对象`)
  }
  return row as Record<string, unknown>
}

function readString(row: Record<string, unknown>, field: string, source: string): string {
  const v = row[field]
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${source} 字段 ${field} 缺失或非非空字符串`)
  }
  return v
}

function readNullableString(
  row: Record<string, unknown>,
  field: string,
  source: string
): string | null {
  const v = row[field]
  if (v === null || v === undefined) {
    return null
  }
  if (typeof v !== 'string') {
    throw new Error(`${source} 字段 ${field} 非字符串`)
  }
  return v
}

function readNumber(row: Record<string, unknown>, field: string, source: string): number {
  const v = row[field]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${source} 字段 ${field} 缺失或非有限数值`)
  }
  return v
}

function readNullableNumber(
  row: Record<string, unknown>,
  field: string,
  source: string
): number | null {
  const v = row[field]
  if (v === null || v === undefined) {
    return null
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${source} 字段 ${field} 非数值`)
  }
  return v
}

function readEnum<T extends string>(
  row: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  source: string
): T {
  const v = readString(row, field, source)
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`${source} 字段 ${field} 值 "${v}" 不在允许集合内`)
  }
  return v as T
}

function readMetadata(row: Record<string, unknown>): Readonly<Record<string, unknown>> | null {
  const raw = readNullableString(row, 'metadataJson', 'memory_records')
  if (raw === null) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('memory_records.metadata_json 不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('memory_records.metadata_json 必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/** memory_records 查询行（camelCase 别名）→ MemoryRecord */
export function parseMemoryRecordRow(row: unknown): MemoryRecord {
  const r = asRow(row, 'memory_records')
  return {
    id: readString(r, 'id', 'memory_records'),
    scopeKind: readEnum(r, 'scopeKind', SCOPE_KINDS, 'memory_records'),
    scopeId: readString(r, 'scopeId', 'memory_records'),
    kind: readEnum(r, 'kind', MEMORY_KINDS, 'memory_records'),
    memoryKey: readNullableString(r, 'memoryKey', 'memory_records'),
    content: readString(r, 'content', 'memory_records'),
    status: readEnum(r, 'status', MEMORY_STATUSES, 'memory_records'),
    confidence: readNumber(r, 'confidence', 'memory_records'),
    explicitness: readEnum(r, 'explicitness', EXPLICITNESS_LEVELS, 'memory_records'),
    sourceType: readString(r, 'sourceType', 'memory_records'),
    validFrom: readNumber(r, 'validFrom', 'memory_records'),
    validTo: readNullableNumber(r, 'validTo', 'memory_records'),
    supersedesId: readNullableString(r, 'supersedesId', 'memory_records'),
    evidenceCount: readNumber(r, 'evidenceCount', 'memory_records'),
    distinctSessionCount: readNumber(r, 'distinctSessionCount', 'memory_records'),
    distinctProjectCount: readNumber(r, 'distinctProjectCount', 'memory_records'),
    sourcePath: readNullableString(r, 'sourcePath', 'memory_records'),
    sourceFingerprint: readNullableString(r, 'sourceFingerprint', 'memory_records'),
    createdAt: readNumber(r, 'createdAt', 'memory_records'),
    updatedAt: readNumber(r, 'updatedAt', 'memory_records'),
    lastSeenAt: readNumber(r, 'lastSeenAt', 'memory_records'),
    metadata: readMetadata(r)
  }
}

/** memory_evidence 查询行（camelCase 别名）→ MemoryEvidence */
export function parseMemoryEvidenceRow(row: unknown): MemoryEvidence {
  const r = asRow(row, 'memory_evidence')
  return {
    id: readString(r, 'id', 'memory_evidence'),
    memoryId: readString(r, 'memoryId', 'memory_evidence'),
    sessionId: readNullableString(r, 'sessionId', 'memory_evidence'),
    messageId: readNullableString(r, 'messageId', 'memory_evidence'),
    projectScopeId: readNullableString(r, 'projectScopeId', 'memory_evidence'),
    evidenceType: readEnum(r, 'evidenceType', MEMORY_EVIDENCE_TYPES, 'memory_evidence'),
    excerpt: readNullableString(r, 'excerpt', 'memory_evidence'),
    createdAt: readNumber(r, 'createdAt', 'memory_evidence')
  }
}

