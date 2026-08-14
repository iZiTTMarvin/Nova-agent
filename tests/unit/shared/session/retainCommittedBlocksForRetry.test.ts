import { describe, expect, it } from 'vitest'
import { retainCommittedBlocksForRetry } from '../../../../src/shared/session/retainCommittedBlocksForRetry'

describe('retainCommittedBlocksForRetry', () => {
  it('无已完成工具时清空整段临时输出', () => {
    expect(
      retainCommittedBlocksForRetry([
        { type: 'thinking', content: '半截' },
        { type: 'text', content: '半截正文' }
      ])
    ).toEqual([])
  })

  it('保留最后一个已完成工具及其前序，丢掉其后临时块', () => {
    const blocks = [
      { type: 'thinking', content: '先想' },
      { type: 'tool', toolCallId: 'tc1', status: 'success' as const },
      { type: 'thinking', content: '失败 attempt 的思考' },
      { type: 'tool', toolCallId: 'tc2', status: 'running' as const }
    ]
    expect(retainCommittedBlocksForRetry(blocks)).toEqual([
      { type: 'thinking', content: '先想' },
      { type: 'tool', toolCallId: 'tc1', status: 'success' }
    ])
  })
})
