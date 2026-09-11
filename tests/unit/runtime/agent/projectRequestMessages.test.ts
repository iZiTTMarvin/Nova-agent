import { describe, it, expect } from 'vitest'
import {
  createRequestProjectionArchiveCache,
  IMAGE_OVERFLOW_OMITTED_PLACEHOLDER,
  IMAGE_REQUEST_BUDGET_PLACEHOLDER,
  imageBlockFingerprint,
  MAX_PROVIDER_IMAGE_REQUEST_BYTES,
  projectRequestMessages
} from '../../../../src/runtime/request-projection'
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

describe('projectRequestMessages omittedImages 溢出降级', () => {
  const imageUrl = 'data:image/png;base64,q93JpYWdl'
  const imageBlock: ContentBlock = { type: 'image_url', image_url: { url: imageUrl } }
  const omittedKey = (toolCallId: string, url = imageUrl): string => `${toolCallId}:${imageBlockFingerprint(url)}`

  it.each([{ enabled: false }, { enabled: true }])('命中复合键的 tool 图片块替换为固定占位文本（policy=%o）', async policy => {
    const messages: ChatMessage[] = [
      { role: 'tool', toolCallId: 'read-1', content: [{ type: 'text', text: '截图' }, imageBlock] }
    ]
    const result = await projectRequestMessages({
      messages,
      policy,
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => null,
      omittedImages: new Set([omittedKey('read-1')])
    })
    expect(result.messages[0].content).toEqual([
      { type: 'text', text: '截图' },
      { type: 'text', text: IMAGE_OVERFLOW_OMITTED_PLACEHOLDER }
    ])
    // 权威原文未被改写
    expect(messages[0].content).toEqual([{ type: 'text', text: '截图' }, imageBlock])
  })

  it('空集合与缺省省略逐字节恒等', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', toolCallId: 'read-1', content: [imageBlock] }
    ]
    const base = {
      messages,
      policy: { enabled: false },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => null
    }
    const [none, empty] = await Promise.all([
      projectRequestMessages(base),
      projectRequestMessages({ ...base, omittedImages: new Set<string>() })
    ])
    expect(JSON.stringify(empty.messages)).toBe(JSON.stringify(none.messages))
    expect(JSON.stringify(none.messages)).toBe(JSON.stringify(messages))
  })

  it('同一集合跨重试投影幂等（字节稳定）', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', toolCallId: 'read-1', content: [{ type: 'text', text: 'a' }, imageBlock] }
    ]
    const input = {
      policy: { enabled: false },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => null,
      omittedImages: new Set([omittedKey('read-1')])
    }
    const first = await projectRequestMessages({ ...input, messages })
    const second = await projectRequestMessages({ ...input, messages: first.messages })
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages))
  })

  it('user 图片与无 toolCallId 的 tool 消息不受影响', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [imageBlock] },
      { role: 'tool', content: [imageBlock] },
      { role: 'assistant', content: '普通历史' }
    ]
    const result = await projectRequestMessages({
      messages,
      policy: { enabled: false },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => null,
      omittedImages: new Set([omittedKey('read-1'), omittedKey('')])
    })
    expect(result.messages).toEqual(messages)
  })

  it('同 URL 不同 toolCallId 只替换目标块', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', toolCallId: 'old', content: [imageBlock] },
      { role: 'tool', toolCallId: 'new', content: [imageBlock] }
    ]
    const result = await projectRequestMessages({
      messages,
      policy: { enabled: false },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => null,
      // 只降级旧批次：新结果同 URL 也保持完整
      omittedImages: new Set([omittedKey('old')])
    })
    expect(result.messages[0].content).toEqual([{ type: 'text', text: IMAGE_OVERFLOW_OMITTED_PLACEHOLDER }])
    expect(result.messages[1].content).toEqual([imageBlock])
  })

  it('与 12 MiB 预算叠加：降级旧图释放空间后，原本被省略的后续图重新进入请求', async () => {
    const oldImage = imageWithRequestBytes(7 * 1024 * 1024)
    const nextImage = imageWithRequestBytes(6 * 1024 * 1024)
    const messages: ChatMessage[] = [
      { role: 'tool', toolCallId: 'old', content: [oldImage] },
      { role: 'tool', toolCallId: 'new', content: [nextImage] }
    ]
    const base = {
      messages,
      policy: { enabled: false },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => null
    }
    const untouched = await projectRequestMessages(base)
    expect(untouched.messages[0].content).toEqual([oldImage])
    expect(untouched.messages[1].content).toEqual([{ type: 'text', text: IMAGE_REQUEST_BUDGET_PLACEHOLDER }])

    const degraded = await projectRequestMessages({
      ...base,
      omittedImages: new Set([omittedKey('old', oldImage.image_url.url)])
    })
    // 释放的额度让后续图重新进入请求；是否为净收益由 Owner 的重试守卫兜底
    expect(degraded.messages[0].content).toEqual([{ type: 'text', text: IMAGE_OVERFLOW_OMITTED_PLACEHOLDER }])
    expect(degraded.messages[1].content).toEqual([nextImage])
  })
})
