import type { MessageOrigin } from '../../runtime/model/types'
import {
  CONTEXT_SNAPSHOT_VERSION,
  type CompactionLedger,
  type LedgerEntry,
  type StateDoc
} from '../../runtime/sessions/types'

export function makeCompactionLedger(opts?: {
  summary?: string
  entryCount?: number
  tailFrom?: MessageOrigin | null
  entries?: LedgerEntry[]
  state?: StateDoc | null
}): CompactionLedger {
  const entries = opts?.entries ?? Array.from({ length: opts?.entryCount ?? 1 }, (_, i) => {
    const id = `c${i + 1}`
    return {
      id,
      shadows: {
        from: { messageId: 'u0', step: 0 },
        to: { messageId: 'a0', step: 0 }
      },
      stub: `[${id}: 折叠 #u0:0–#a0:0；原文可用 history_read("${id}")]`,
      touchedFiles: [],
      trigger: 'threshold' as const,
      createdAt: 0
    }
  })
  const summary = opts?.summary ?? '摘要'
  return {
    version: CONTEXT_SNAPSHOT_VERSION,
    entries,
    state: opts?.state !== undefined
      ? opts.state
      : {
          text: summary,
          coversThrough: { messageId: 'a0', step: 0 },
          taskVerbatim: null,
          realityLine: '',
          revision: Math.max(1, entries.length)
        },
    tailFrom: opts?.tailFrom !== undefined ? opts.tailFrom : { messageId: 'u0', step: 0 },
    updatedAt: 0
  }
}
