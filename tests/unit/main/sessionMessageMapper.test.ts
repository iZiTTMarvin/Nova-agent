import { describe, expect, it } from 'vitest'
import { toSharedMessage } from '../../../src/main/ipc/sessionMessageMapper'
import type { SessionMessage } from '../../../src/runtime/sessions/types'

describe('sessionMessageMapper', () => {
  it('应保留持久化 blocks，并把工具参数恢复为对象', () => {
    const message: SessionMessage = {
      id: 'msg_1',
      role: 'assistant',
      content: '计划内容',
      toolCalls: [
        {
          id: 'tc_1',
          name: 'read',
          arguments: '{"path":"src/app.ts"}',
          result: 'ok'
        }
      ],
      blocks: [
        { type: 'thinking', content: '先看入口' },
        {
          type: 'tool',
          toolCallId: 'tc_1',
          toolName: 'read',
          arguments: '{"path":"src/app.ts"}' as unknown as Record<string, unknown>,
          status: 'success',
          result: 'ok'
        },
        { type: 'text', content: '已找到入口' }
      ],
      timestamp: 1
    }

    const shared = toSharedMessage(message)

    expect(shared.toolCalls?.[0].arguments).toEqual({ path: 'src/app.ts' })
    expect(shared.blocks).toEqual([
      { type: 'thinking', content: '先看入口' },
      {
        type: 'tool',
        toolCallId: 'tc_1',
        toolName: 'read',
        arguments: { path: 'src/app.ts' },
        status: 'success',
        result: 'ok'
      },
      { type: 'text', content: '已找到入口' }
    ])
    expect(shared._toolCallResults).toEqual({ tc_1: 'ok' })
  })

  it('工具参数损坏时应安全回退为空对象', () => {
    const message: SessionMessage = {
      id: 'msg_2',
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'tc_2',
          name: 'read',
          arguments: '{bad json',
          result: '工具执行失败: boom'
        }
      ],
      timestamp: 2
    }

    const shared = toSharedMessage(message)

    expect(shared.toolCalls?.[0].arguments).toEqual({})
  })
})
