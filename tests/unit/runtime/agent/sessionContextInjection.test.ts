import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import type { ChatMessage, ContentBlock } from '../../../../src/runtime/model/types'

/**
 * Session context 注入集成测试（v2 合并方案）
 *
 * v2 修正：session context 不再作为独立 internal 消息注入，而是拼到每轮第一条
 * user 消息的 content 前缀。模型在同一条 user 消息里看到：
 *   "[Session context: ...]\n\n用户真实输入"
 *
 * 关键验证点：
 *  - session context 在 user 消息 content 前缀中（不在独立消息里）
 *  - context 中没有独立 internal 消息（消息条数不增加）
 *  - 跨日去重：同一天第二轮 user 消息 content 不含 session context 前缀
 *  - setWorkingDir 重置去重，强制下次重新拼接
 *
 * 注意：MockModelClient 记录收到的 messages（含 content），可验证前缀拼接。
 */

function createLoop(mockClient?: MockModelClient) {
  const client = mockClient ?? new MockModelClient()
  const eventBus = new EventBus()
  const loop = new AgentLoop(client, eventBus)
  return { loop, client }
}

/** 可控日期的测试循环：用于验证跨天重注。 */
class TestDateAgentLoop extends AgentLoop {
  private currentDate = new Date('2026-06-15T12:00:00')

  setSessionDate(date: string | Date): void {
    this.currentDate = typeof date === 'string' ? new Date(date) : date
  }

  protected override getSessionContextDate(): Date {
    return this.currentDate
  }
}

/** 从 messages 中找到最后一条 user 消息 */
function lastUserMsg(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i]
  }
  return undefined
}

/** 提取消息 content 的文本（string 或 ContentBlock[] → text） */
function msgText(msg: ChatMessage | undefined): string {
  if (!msg) return ''
  return typeof msg.content === 'string' ? msg.content : ''
}

describe('AgentLoop session context 注入（v2 合并方案）', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('首轮：session context 拼在 user 消息 content 前缀，模型在同一条消息里看到', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    loop.setWorkingDir('D:/proj/nova')

    await loop.sendMessage('hello')

    const received = client.getCalls()[0].messages
    // 找到真实的 user 消息（最后一条 user）
    const userMsg = lastUserMsg(received)
    expect(userMsg).toBeDefined()
    const text = msgText(userMsg)

    // session context 在 user 消息 content 的最前面
    expect(text.startsWith('[Session context:')).toBe(true)
    expect(text).toContain('Working directory: D:/proj/nova')
    // 真实用户输入也在同一条消息里
    expect(text).toContain('hello')
  })

  it('context 中没有独立 internal 消息（消息条数不增加）', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    loop.setWorkingDir('D:/proj')

    await loop.sendMessage('hello')

    const received = client.getCalls()[0].messages
    // 应该只有：system + user（2 条），没有独立的 session context 消息
    expect(received).toHaveLength(2)
    expect(received[0].role).toBe('system')
    expect(received[1].role).toBe('user')
    // 没有任何消息标记 internal
    expect(received.every(m => !m.internal)).toBe(true)
  })

  it('同日去重：同一天第二轮 user 消息 content 不含 session context 前缀', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复1' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复2' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    loop.setWorkingDir('D:/proj')

    await loop.sendMessage('第一条')
    await loop.sendMessage('第二条')

    const call2 = client.getCalls()[1].messages
    const userMsg2 = lastUserMsg(call2)
    const text2 = msgText(userMsg2)

    // 第二轮 user 消息不含 session context 前缀（同一天已注入过）
    expect(text2.startsWith('[Session context:')).toBe(false)
    expect(text2).toContain('第二条')
  })

  it('首轮是多模态 user 消息时，后续同日轮次仍能识别已有锚点并跳过重注', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复1' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复2' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const firstTurn: ContentBlock[] = [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
    ]

    const { loop } = createLoop(client)
    loop.setWorkingDir('D:/proj')

    await loop.sendMessage(firstTurn)
    await loop.sendMessage('第二条')

    const call2 = client.getCalls()[1].messages
    const userMsg2 = lastUserMsg(call2)
    const text2 = msgText(userMsg2)

    expect(text2.startsWith('[Session context:')).toBe(false)
    expect(text2).toContain('第二条')
  })

  it('跨天重注：旧锚点日期失效后，下一轮重新注入前缀', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复1' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复2' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const eventBus = new EventBus()
    const loop = new TestDateAgentLoop(client, eventBus)
    loop.setWorkingDir('D:/proj')
    loop.setSessionDate('2026-06-15T12:00:00')

    await loop.sendMessage('第一天')

    loop.setSessionDate('2026-06-16T12:00:00')
    await loop.sendMessage('第二天')

    const call2 = client.getCalls()[1].messages
    const userMsg2 = lastUserMsg(call2)
    const text2 = msgText(userMsg2)

    expect(text2.startsWith('[Session context:')).toBe(true)
    expect(text2).toContain('Today is 2026-06-16')
    expect(text2).toContain('第二天')
  })

  it('setWorkingDir 后强制下次重新拼接 session context 前缀', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复1' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复2' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    loop.setWorkingDir('D:/proj/a')

    await loop.sendMessage('第一条')
    // 切工作区 → 重置去重
    loop.setWorkingDir('D:/proj/b')
    await loop.sendMessage('第二条')

    const call2 = client.getCalls()[1].messages
    const userMsg2 = lastUserMsg(call2)
    const text2 = msgText(userMsg2)

    // 第二轮 user 消息重新包含 session context 前缀，且反映新工作区
    expect(text2.startsWith('[Session context:')).toBe(true)
    expect(text2).toContain('D:/proj/b')
  })

  it('setWorkingDir 切到旧路径前缀时也会重新注入，避免子串误判', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复1' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复2' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    loop.setWorkingDir('D:/proj/nova-app')

    await loop.sendMessage('旧工作区')
    loop.setWorkingDir('D:/proj/nova')
    await loop.sendMessage('新工作区')

    const call2 = client.getCalls()[1].messages
    const userMsg2 = lastUserMsg(call2)
    const text2 = msgText(userMsg2)

    expect(text2.startsWith('[Session context:')).toBe(true)
    expect(text2).toContain('Working directory: D:/proj/nova]')
  })

  it('session context 前缀包含日期、模型、OS、工作区四个锚点', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'ok' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    loop.setWorkingDir('D:/proj/anchors')

    await loop.sendMessage('hi')

    const received = client.getCalls()[0].messages
    const userMsg = lastUserMsg(received)
    const text = msgText(userMsg)
    expect(text).toContain('Today is')
    expect(text).toContain('Current model:')
    expect(text).toContain('OS:')
    expect(text).toContain('Working directory: D:/proj/anchors')
  })

  // ── v3 生命周期回归测试（审查 P2）──────────────────────────────────

  it('reset() 后重发：context 清空 → 无锚点 → 重新注入前缀', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复1' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复2' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    loop.setWorkingDir('D:/proj')

    await loop.sendMessage('第一条')
    // reset 清空 context（system 除外）→ 锚点消失
    loop.reset()
    await loop.sendMessage('reset 后第一条')

    const call2 = client.getCalls()[1].messages
    const userMsg2 = lastUserMsg(call2)
    const text2 = msgText(userMsg2)

    // reset 后首条消息重新注入 session context 前缀
    expect(text2.startsWith('[Session context:')).toBe(true)
    expect(text2).toContain('Working directory: D:/proj')
  })

  it('压缩后重发：带前缀的旧消息被摘要吃掉 → 锚点消失 → 重新注入前缀', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复1' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复2' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    loop.setWorkingDir('D:/proj')

    await loop.sendMessage('第一条')
    // 模拟压缩：手动清空 context 中所有非 system 消息（等价于 rebuildWithCompression
    // 后带前缀的旧 user 消息被摘要替代的场景）
    const currentContext = loop.getContext()
    const systemMsg = currentContext.find(m => m.role === 'system')
    // 用 reset + injectHistory 模拟压缩后的 context 重建（只有 system + 摘要，无锚点）
    loop.reset()
    // 压缩后 context 只有 system（含摘要），没有含 [Session context] 的消息
    void systemMsg

    await loop.sendMessage('压缩后第一条')

    const call2 = client.getCalls()[1].messages
    const userMsg2 = lastUserMsg(call2)
    const text2 = msgText(userMsg2)

    // 压缩后首条消息重新注入 session context 前缀
    expect(text2.startsWith('[Session context:')).toBe(true)
    expect(text2).toContain('Working directory: D:/proj')
  })

  it('context 中仍保留有效锚点时不重复注入（扫描正确跳过）', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复1' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复2' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    loop.setWorkingDir('D:/proj/persist')

    await loop.sendMessage('第一条')
    // 不 reset、不切工作区 —— 第一条的锚点仍在 context 中
    await loop.sendMessage('第二条')

    const call2 = client.getCalls()[1].messages
    const userMsg2 = lastUserMsg(call2)
    const text2 = msgText(userMsg2)

    // 第二条不含前缀（锚点仍在 context 中，扫描跳过）
    expect(text2.startsWith('[Session context:')).toBe(false)
    expect(text2).toContain('第二条')
  })
})
