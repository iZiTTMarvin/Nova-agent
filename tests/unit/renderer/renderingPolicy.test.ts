import { describe, expect, it } from 'vitest'
import { isActiveThinkingBlock, isPermissionDeniedResult, shouldRenderToolBlock } from '../../../src/renderer/features/chat/renderingPolicy'
import type { MessageBlock } from '../../../src/shared/session/types'

describe('renderingPolicy', () => {
  it('只有最后一个 thinking block 会被标记为 active', () => {
    const blocks: MessageBlock[] = [
      { type: 'thinking', content: '先读目录' },
      { type: 'tool', toolCallId: 'tc_1', toolName: 'ls', arguments: {}, status: 'success', result: 'ok' },
      { type: 'thinking', content: '继续分析' }
    ]

    expect(isActiveThinkingBlock(blocks, 0, true, 'msg_1', 'msg_1')).toBe(false)
    expect(isActiveThinkingBlock(blocks, 2, true, 'msg_1', 'msg_1')).toBe(true)
  })

  it('plan 模式不渲染写入类工具卡', () => {
    expect(shouldRenderToolBlock('plan', 'write')).toBe(false)
    expect(shouldRenderToolBlock('plan', 'bash')).toBe(false)
    expect(shouldRenderToolBlock('plan', 'read')).toBe(true)
    expect(shouldRenderToolBlock('default', 'write')).toBe(true)
  })

  it('todo_write 由顶部面板统一展示，所有模式都不在消息流渲染', () => {
    expect(shouldRenderToolBlock('default', 'todo_write')).toBe(false)
    expect(shouldRenderToolBlock('plan', 'todo_write')).toBe(false)
    expect(shouldRenderToolBlock('compose', 'todo_write')).toBe(false)
  })

  it('权限拒绝结果应隐藏 arguments', () => {
    expect(isPermissionDeniedResult('权限拒绝: 当前为 plan 模式')).toBe(true)
    expect(isPermissionDeniedResult('工具执行失败: boom')).toBe(false)
  })
})
