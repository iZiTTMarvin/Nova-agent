/**
 * projectRequestMessages 投影层骨架测试。
 *
 * 只验证投影关闭态的行为：原样返回、不 mutate 输入、幂等、不调用 archive。
 * 归档逻辑启用后，这些测试仍然成立。
 */
import { describe, it, expect } from 'vitest'
import {
  createRequestProjectionArchiveCache,
  projectRequestMessages
} from '../../../../src/runtime/agent/core/projectRequestMessages'
import type { ChatMessage } from '../../../../src/runtime/model/types'

describe('projectRequestMessages', () => {
  it('policy.enabled=false 时原样返回，诊断全为零', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'tool', content: 'big output', toolCallId: 'tc1' }
    ]
    const result = await projectRequestMessages({
      messages,
      toolRound: 1,
      policy: { enabled: false },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => null
    })
    expect(result.messages).toEqual(messages)
    expect(result.diagnostics).toEqual({ prunedCount: 0, archiveFailures: 0, estimatedTokensSaved: 0 })
  })

  it('投影不 mutate 输入消息', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'x'.repeat(10000), toolCallId: 'tc1' }
    ]
    const snapshot = JSON.parse(JSON.stringify(messages))
    await projectRequestMessages({
      messages,
      toolRound: 1,
      policy: { enabled: false },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => null
    })
    expect(JSON.parse(JSON.stringify(messages))).toEqual(snapshot)
  })

  it('连续投影两次结果相同（幂等）', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'x'.repeat(10000), toolCallId: 'tc1' }
    ]
    const first = await projectRequestMessages({
      messages,
      toolRound: 1,
      policy: { enabled: false },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => null
    })
    const second = await projectRequestMessages({
      messages: first.messages,
      toolRound: 1,
      policy: { enabled: false },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => null
    })
    expect(second.messages).toEqual(first.messages)
  })

  it('policy.enabled=false 时不调用 archive 回调', async () => {
    let called = false
    await projectRequestMessages({
      messages: [{ role: 'user', content: 'hi' }],
      toolRound: 1,
      policy: { enabled: false },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => { called = true; return null }
    })
    expect(called).toBe(false)
  })
})
