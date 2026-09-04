import { describe, it, expect } from 'vitest'
import {
  createRequestProjectionArchiveCache,
  IMAGE_REQUEST_BUDGET_PLACEHOLDER,
  MAX_PROVIDER_IMAGE_REQUEST_BYTES,
  projectRequestMessages
} from '../../../../src/runtime/agent/core/projectRequestMessages'
import type { ChatMessage, ContentBlock } from '../../../../src/runtime/model/types'

function imageWithRequestBytes(bytes: number): Extract<ContentBlock, { type: 'image_url' }> {
  const block = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,' } }
  const overhead = Buffer.byteLength(JSON.stringify(block), 'utf8')
  return { ...block, image_url: { url: block.image_url.url + 'A'.repeat(bytes - overhead) } }
}

describe('projectRequestMessages', () => {
  it('policy.enabled=false 时原样返回，诊断全为零', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'tool', content: 'big output', toolCallId: 'tc1' }
    ]
    const result = await projectRequestMessages({
      messages,
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
      policy: { enabled: false },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => null
    })
    const second = await projectRequestMessages({
      messages: first.messages,
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
      policy: { enabled: false },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => { called = true; return null }
    })
    expect(called).toBe(false)
  })

  it.each([
    { enabled: false },
    { enabled: true }
  ])('图片预算不依赖工具归档开关：%o', async ({ enabled }) => {
    const first = imageWithRequestBytes(6 * 1024 * 1024)
    const overflow = imageWithRequestBytes(7 * 1024 * 1024)
    const later = imageWithRequestBytes(1024)
    const messages: ChatMessage[] = [
      { role: 'user', content: [first] },
      { role: 'tool', toolCallId: 'read-image', content: [
        { type: 'text', text: '保留说明' }, overflow, later
      ] }
    ]
    const input = {
      messages,
      policy: { enabled },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => { throw new Error('图片投影不应写归档') }
    }
    const result = await projectRequestMessages(input)
    expect(result.messages).toEqual([
      messages[0],
      { role: 'tool', toolCallId: 'read-image', content: [
        { type: 'text', text: '保留说明' },
        { type: 'text', text: IMAGE_REQUEST_BUDGET_PLACEHOLDER }, later
      ] }
    ])
    expect(messages[1].content).toEqual([{ type: 'text', text: '保留说明' }, overflow, later])
    expect((await projectRequestMessages({ ...input, messages: result.messages })).messages)
      .toEqual(result.messages)
    expect((await projectRequestMessages(input)).messages).toEqual(result.messages)
  })

  it('图片 JSON 的 UTF-8 字节恰好达到上限仍保留，额外图片逐张省略', async () => {
    const remote: ContentBlock = { type: 'image_url', image_url: { url: 'https://example.test/图.png' } }
    const remoteBytes = Buffer.byteLength(JSON.stringify(remote), 'utf8')
    const filler = imageWithRequestBytes(MAX_PROVIDER_IMAGE_REQUEST_BYTES - remoteBytes)
    const extra: ContentBlock = { type: 'image_url', image_url: { url: 'https://example.test/next.png' } }
    const result = await projectRequestMessages({
      messages: [{ role: 'user', content: [filler, remote, extra] }],
      policy: { enabled: false },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => null
    })
    expect(result.messages[0].content).toEqual([
      filler, remote, { type: 'text', text: IMAGE_REQUEST_BUDGET_PLACEHOLDER }
    ])
  })
})
