/**
 * 流式正文块打字机门控：决定某个 text 块在轮次进行中是否启用逐字放出。
 *
 * 背景：tool_call_start 会在 blocks 序列中切开正文。已封口的历史 text 块若仍走
 * 打字机，会在工具卡片之间露出残片（如「token 消费 SSE」、截断反引号「`方法」）。
 */
import type { RendererMessageBlock } from '../../stores/types'

/** 从 blocks 尾部向前找最后一个 text 块的索引；不存在则 -1。 */
export function getLastTextBlockIndex(blocks: RendererMessageBlock[] | undefined): number {
  if (!blocks || blocks.length === 0) return -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'text') return i
  }
  return -1
}

/** blocks 尾部是否仍是 text（即该块仍在接收 text_delta）。 */
export function isTailActiveTextBlock(blocks: RendererMessageBlock[] | undefined): boolean {
  if (!blocks || blocks.length === 0) return false
  return blocks[blocks.length - 1].type === 'text'
}

export interface TextBlockTypewriterGateInput {
  /** 当前 assistant 轮次是否仍在进行（message_end 前） */
  isTurnActive: boolean
  /** 待判定的 text 块在 blocks 中的下标 */
  blockIndex: number
  blocks: RendererMessageBlock[] | undefined
}

/**
 * 是否对该 text 块启用打字机。
 * 仅当：轮次进行中 + 尾部仍是 text + 该块是最后一个 text 块。
 */
export function shouldEnableTextBlockTypewriter(input: TextBlockTypewriterGateInput): boolean {
  const { isTurnActive, blockIndex, blocks } = input
  if (!isTurnActive) return false
  const lastTextBlockIndex = getLastTextBlockIndex(blocks)
  if (lastTextBlockIndex < 0) return false
  return isTailActiveTextBlock(blocks) && blockIndex === lastTextBlockIndex
}
