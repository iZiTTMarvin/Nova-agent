import type { RunSnapshot } from './types'
import { sanitizeToolOutput } from '../tool-input-sanitizer'

/** 草稿全文仅供持久化与恢复；跨 IPC 的快照使用工具预览。 */
export function toRendererRunSnapshot(snapshot: RunSnapshot | null): RunSnapshot | null {
  if (!snapshot?.turnDraft) return snapshot
  const { userDelivery: _delivery, ...draft } = snapshot.turnDraft
  return { ...snapshot, turnDraft: { ...draft, blocks: draft.blocks.map(block => {
    if (block.type !== 'tool') return block
    const { delivery: _toolDelivery, ...displayBlock } = block
    return { ...displayBlock, ...(block.result !== undefined ? { result: sanitizeToolOutput(block.toolName, block.result, block.status === 'error') } : {}) }
  }) } }
}
