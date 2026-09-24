export type LearningDbHostMessage =
  | { kind: 'open'; requestId: number; dbPath: string }
  | { kind: 'transaction'; requestId: number; statements: readonly { sql: string; params?: readonly unknown[] }[] }
  | { kind: 'close'; requestId: number }

export type LearningDbWorkerMessage =
  | { kind: 'ready' }
  | { kind: 'ok'; requestId: number }
  | { kind: 'error'; requestId: number; message: string }

export function parseLearningDbHostMessage(raw: unknown): LearningDbHostMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const requestId = value.requestId
  if (!Number.isInteger(requestId)) return null
  const kind = value.kind
  if (kind === 'open' && typeof value.dbPath === 'string') {
    return { kind: 'open', requestId: requestId as number, dbPath: value.dbPath }
  }
  if (kind === 'close') {
    return { kind: 'close', requestId: requestId as number }
  }
  if (kind === 'transaction' && Array.isArray(value.statements)) {
    const statements: { sql: string; params?: readonly unknown[] }[] = []
    for (const item of value.statements) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (typeof row.sql !== 'string') continue
      const params = Array.isArray(row.params) ? [...row.params] : undefined
      statements.push({ sql: row.sql, params })
    }
    return { kind: 'transaction', requestId: requestId as number, statements }
  }
  return null
}
