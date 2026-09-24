export type LearningDbHostMessage =
  | { kind: 'open'; requestId: number; dbPath: string }
  | { kind: 'close'; requestId: number }
  | { kind: 'invoke'; requestId: number; command: unknown }

export type LearningDbWorkerMessage =
  | { kind: 'ready' }
  | { kind: 'ok'; requestId: number; result?: unknown }
  | { kind: 'error'; requestId: number; message: string; code?: string }

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
  if (kind === 'invoke' && value.command !== undefined) {
    return { kind: 'invoke', requestId: requestId as number, command: value.command }
  }
  return null
}
