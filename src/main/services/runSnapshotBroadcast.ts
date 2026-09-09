import type { RunEventRecord, RunSnapshot } from '../../shared/run/types'

const COALESCE_MS = 50

const COALESCE_EVENT_TYPES = new Set([
  'heartbeat',
  'tool_phase',
  'turn_draft_upsert'
])

export type SnapshotBroadcastSend = (snapshot: RunSnapshot, event: RunEventRecord) => void

/** 中间态 50ms 合帧只发最新快照；终态 / 等待用户 / 交互立即发出。 */
export class SnapshotBroadcastCoalescer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: { snapshot: RunSnapshot; event: RunEventRecord } | null = null

  constructor(private readonly send: SnapshotBroadcastSend) {}

  push(snapshot: RunSnapshot, event: RunEventRecord): void {
    if (!COALESCE_EVENT_TYPES.has(event.type)) {
      this.flush()
      this.send(snapshot, event)
      return
    }
    this.pending = { snapshot, event }
    if (this.timer == null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, COALESCE_MS)
    }
  }

  flush(): void {
    if (this.timer != null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const next = this.pending
    this.pending = null
    if (next) this.send(next.snapshot, next.event)
  }

  cancel(): void {
    if (this.timer != null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
  }
}
