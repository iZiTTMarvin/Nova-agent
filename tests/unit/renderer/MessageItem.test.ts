import { describe, it, expect } from 'vitest'
import { areEqual } from '../../../src/renderer/features/chat/MessageItem'
import type { MessageItemProps } from '../../../src/renderer/features/chat/MessageItem'
import type { ExtendedMessage, MessageDiffCache } from '../../../src/renderer/stores/types'

/** 稳定的回调引用，跨 makeProps 调用共享 */
const stableRollback = async (_messageId: string) => {}
const stableAcceptFile = async (_sid: string, _mid: string, _fp: string) => {}
const stableRejectFile = async (_sid: string, _mid: string, _fp: string) => {}
const stableRenderPoolTick = () => {}

/** 构造一个最小的 MessageItemProps，各字段可覆盖 */
function makeProps(overrides: Partial<MessageItemProps> = {}): MessageItemProps {
  return {
    msg: {
      id: 'msg_1',
      sessionId: 'sess_1',
      role: 'assistant',
      content: 'hello',
      timestamp: 0,
      _revision: 0
    },
    isGenerating: false,
    currentGeneratingMessageId: null,
    currentMode: 'default' as const,
    currentSessionId: 'sess_1',
    onRollback: stableRollback,
    onAcceptFile: stableAcceptFile,
    onRejectFile: stableRejectFile,
    onRenderPoolTick: stableRenderPoolTick,
    diffCache: undefined,
    isDiffLoading: false,
    diffPlaceholders: undefined,
    ...overrides
  }
}

describe('MessageItem areEqual', () => {
  it('完全相同的 props 应返回 true', () => {
    const prev = makeProps()
    const next = makeProps()
    expect(areEqual(prev, next)).toBe(true)
  })

  it('msg.id 不同应返回 false', () => {
    const prev = makeProps()
    const next = makeProps({ msg: { ...prev.msg, id: 'msg_2' } })
    expect(areEqual(prev, next)).toBe(false)
  })

  it('msg._revision 不同应返回 false', () => {
    const prev = makeProps()
    const next = makeProps({ msg: { ...prev.msg, _revision: 1 } })
    expect(areEqual(prev, next)).toBe(false)
  })

  it('isGenerating 不同应返回 false', () => {
    const prev = makeProps()
    const next = makeProps({ isGenerating: true })
    expect(areEqual(prev, next)).toBe(false)
  })

  it('currentGeneratingMessageId 不同应返回 false', () => {
    const prev = makeProps()
    const next = makeProps({ currentGeneratingMessageId: 'msg_1' })
    expect(areEqual(prev, next)).toBe(false)
  })

  it('currentMode 不同应返回 false', () => {
    const prev = makeProps()
    const next = makeProps({ currentMode: 'auto' as const })
    expect(areEqual(prev, next)).toBe(false)
  })

  it('currentSessionId 不同应返回 false', () => {
    const prev = makeProps()
    const next = makeProps({ currentSessionId: 'sess_2' })
    expect(areEqual(prev, next)).toBe(false)
  })

  it('onRollback 引用不同应返回 false', () => {
    const prev = makeProps()
    const next = makeProps({ onRollback: () => {} })
    expect(areEqual(prev, next)).toBe(false)
  })

  it('diffCache 引用不同应返回 false', () => {
    const prev = makeProps({ diffCache: { diffs: [], reviews: {} } })
    const next = makeProps({ diffCache: { diffs: [], reviews: {} } })
    expect(areEqual(prev, next)).toBe(false)
  })

  it('diffCache 同一引用应返回 true', () => {
    const cache: MessageDiffCache = { diffs: [], reviews: {} }
    const prev = makeProps({ diffCache: cache })
    const next = makeProps({ diffCache: cache })
    expect(areEqual(prev, next)).toBe(true)
  })

  it('isDiffLoading 不同应返回 false', () => {
    const prev = makeProps()
    const next = makeProps({ isDiffLoading: true })
    expect(areEqual(prev, next)).toBe(false)
  })

  it('diffPlaceholders 引用不同应返回 false', () => {
    const prev = makeProps({ diffPlaceholders: [{ filePath: 'a.ts', status: 'modified' }] })
    const next = makeProps({ diffPlaceholders: [{ filePath: 'a.ts', status: 'modified' }] })
    expect(areEqual(prev, next)).toBe(false)
  })

  it('msg._revision 相同但 content 不同（不应出现，但 areEqual 不比 content）应返回 true', () => {
    // areEqual 只比 _revision 不比 content，这是设计意图：
    // _revision 变了才重渲染，content 变了但 _revision 没变说明 store 有 bug
    const prev = makeProps()
    const next = makeProps({ msg: { ...prev.msg, content: 'changed' } })
    // _revision 相同 → areEqual 返回 true（不重渲染）
    expect(areEqual(prev, next)).toBe(true)
  })
})
