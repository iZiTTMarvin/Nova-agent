import type { MessageOrigin } from '../../runtime/model/types'
import {
  CONTEXT_SNAPSHOT_VERSION,
  type CompactionLedger,
  type LedgerEntry,
  type StateDoc
} from '../../runtime/sessions'

export function makeCompactionLedger(opts?: {
  summary?: string
  entryCount?: number
  tailFrom?: MessageOrigin | null
  entries?: LedgerEntry[]
  state?: StateDoc | null
  shadows?: { from: MessageOrigin; to: MessageOrigin }
}): CompactionLedger {
  const shadows = opts?.shadows ?? {
    from: { messageId: 'u0', step: 0 },
    to: { messageId: 'a0', step: 0 }
  }
  const entries = opts?.entries ?? Array.from({ length: opts?.entryCount ?? 1 }, (_, i) => {
    const id = `c${i + 1}`
    return {
      id,
      shadows,
      stub: `[${id}: 折叠 #${shadows.from.messageId}:${shadows.from.step}–#${shadows.to.messageId}:${shadows.to.step}；原文可用 history_read("${id}")]`,
      touchedFiles: { paths: [], omittedCount: 0 },
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
          coversThrough: entries.at(-1)?.shadows.to ?? shadows.to,
          taskVerbatim: null,
          realityLine: '',
          revision: Math.max(1, entries.length)
        },
    tailFrom: opts?.tailFrom !== undefined ? opts.tailFrom : { messageId: 'u0', step: 0 },
    updatedAt: 0
  }
}
