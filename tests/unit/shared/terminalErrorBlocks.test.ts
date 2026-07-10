/**
 * 终态错误并入 blocks：主进程 / 渲染层共用逻辑
 */
import { describe, it, expect } from 'vitest'
import {
  TERMINAL_ERROR_NOTICE_PREFIX,
  formatTerminalErrorNotice,
  appendTerminalErrorToBlocks
} from '../../../src/shared/session/terminalErrorBlocks'
import type { MessageBlock } from '../../../src/shared/session/types'

describe('appendTerminalErrorToBlocks', () => {
  it('前缀常量与 format 一致', () => {
    expect(formatTerminalErrorNotice('预算用尽')).toBe(`${TERMINAL_ERROR_NOTICE_PREFIX}预算用尽`)
  })

  it('末尾 text 拼接提示；running tool 标为 error', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'tool',
        toolCallId: 'tc1',
        toolName: 'ls',
        arguments: {},
        status: 'running'
      },
      { type: 'text', content: '已成功的回复' }
    ]
    const out = appendTerminalErrorToBlocks(blocks, 'API 超时')
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ type: 'tool', status: 'error', result: 'API 超时' })
    expect(out[1]).toMatchObject({
      type: 'text',
      content: expect.stringContaining('已成功的回复')
    })
    expect((out[1] as { content: string }).content).toContain('API 超时')
    expect((out[1] as { content: string }).content).toContain(TERMINAL_ERROR_NOTICE_PREFIX)
  })

  it('末尾非 text 时新增 text 错误块', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'tool',
        toolCallId: 'tc1',
        toolName: 'ls',
        arguments: {},
        status: 'success',
        result: 'ok'
      }
    ]
    const out = appendTerminalErrorToBlocks(blocks, '熔断')
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({
      type: 'text',
      content: formatTerminalErrorNotice('熔断')
    })
  })
})
