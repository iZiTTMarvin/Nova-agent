// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { areEqual } from '../../../src/renderer/features/chat/MessageItem'
import type { MessageItemProps } from '../../../src/renderer/features/chat/MessageItem'

const stableRegenerate = async (_messageId: string) => {}
const stableAcceptFile = async (_sid: string, _mid: string, _fp: string) => {}
const stableRejectFile = async (_sid: string, _mid: string, _fp: string) => {}
const stableRenderPoolTick = () => {}

function makeProps(overrides: Partial<MessageItemProps> = {}): MessageItemProps {
  return {
    msg: { id: 'msg_1', sessionId: 'sess_1', role: 'assistant', content: 'hello', timestamp: 0, _revision: 0 },
    isGenerating: false,
    currentGeneratingMessageId: null,
    currentMode: 'default',
    currentSessionId: 'sess_1',
    onRegenerate: stableRegenerate,
    regenerateBlocked: false,
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
  it('稳定 props 保持 memo 命中', () => {
    expect(areEqual(makeProps(), makeProps())).toBe(true)
  })

  it('消息 revision 变化会重新渲染', () => {
    const prev = makeProps()
    const next = makeProps({ msg: { ...prev.msg, _revision: 1 } })
    expect(areEqual(prev, next)).toBe(false)
  })

  it('等待用户输入状态变化会重新渲染以停止流式动画', () => {
    const prev = makeProps({ isPausedForInput: false })
    const next = makeProps({ isPausedForInput: true })
    expect(areEqual(prev, next)).toBe(false)
  })

  it('content 变化必须由 revision 驱动，revision 不变时仍保持 memo 命中', () => {
    const prev = makeProps()
    const next = makeProps({ msg: { ...prev.msg, content: 'changed' } })
    expect(areEqual(prev, next)).toBe(true)
  })

})
