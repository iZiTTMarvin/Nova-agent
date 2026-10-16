import type { ExtendedMessage, MessageDiffCache } from '../../stores/types'
import type { DiffEntry } from '../../../shared/diff/types'
import type { PlanTarget } from '../../stores/useLayoutStore'
import { countEntryChanges } from '../../../shared/diff/compute'

export interface StatusDiffTurn {
  messageId: string
  label: string
  cache: MessageDiffCache | undefined
  files: Array<Pick<DiffEntry, 'filePath' | 'status'>>
  added: number
  removed: number
}

export function findStatusPlan(messages: readonly ExtendedMessage[], sessionId: string): (PlanTarget & { title: string }) | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.sessionId !== sessionId) continue
    const blocks = message.blocks ?? []
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j]
      if (block.type !== 'tool' || block.toolName !== 'save_plan' || block.status !== 'success') continue
      return {
        sessionId, messageId: message.id, toolCallId: block.toolCallId,
        title: typeof block.arguments.title === 'string' ? block.arguments.title : '实施计划'
      }
    }
  }
  return null
}

export function buildStatusDiffTurns(
  messages: readonly ExtendedMessage[],
  sessionId: string,
  caches: Record<string, MessageDiffCache>,
  placeholders: Record<string, Array<Pick<DiffEntry, 'filePath' | 'status'>>>
): StatusDiffTurn[] {
  const turns: StatusDiffTurn[] = []
  for (const message of messages) {
    if (message.sessionId !== sessionId || message.role !== 'assistant') continue
    const cache = caches[message.id]
    const files = cache?.diffs ?? placeholders[message.id] ?? []
    if (files.length === 0 && !cache?.skippedFiles?.length) continue
    let added = 0
    let removed = 0
    for (const diff of cache?.diffs ?? []) {
      const counts = countEntryChanges(diff)
      added += counts.additions
      removed += counts.deletions
    }
    const time = new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    turns.push({ messageId: message.id, label: `${time} · ${files.length} 个文件`, cache, files, added, removed })
  }
  return turns.reverse()
}

export const STATUS_RAIL_WIDTH = 0
export const STATUS_RAIL_COMPACT_WIDTH = 0
export const STATUS_WIDE_MIN_WIDTH = 680

export function statusRailWidth(_workspaceWidth: number, _inspectorOpen: boolean, _hasRail: boolean): number {
  return 0
}
