import { describe, it, expect } from 'vitest'
import { estimateImageBlockBudgetTokens, parseImageDataUrlSize, resolveImageBudgetRule } from '../../../../src/runtime/model/imageTokens'
import { measureRequestBudget } from '../../../../src/runtime/model/requestBudget'
import { estimateContextSize } from '../../../../src/runtime/agent/ContextBudgetManager'
import type { ChatMessage } from '../../../../src/runtime/model/types'

/** 构造只含头部的最小 PNG data URL（解析器只读头 32 字节） */
function pngDataUrl(width: number, height: number): string {
  const head = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'latin1')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return `data:image/png;base64,${head.toString('base64')}${'A'.repeat(64)}`
}

function jpegDataUrl(width: number, height: number): string {
  const head = Buffer.alloc(64)
  head[0] = 0xff; head[1] = 0xd8
  head[2] = 0xff; head[3] = 0xe0 // APP0
  head.writeUInt16BE(16, 4)
  const sof = 24
  head[sof] = 0xff; head[sof + 1] = 0xc0 // SOF0
  head.writeUInt16BE(17, sof + 2)
  head[sof + 4] = 8
  head.writeUInt16BE(height, sof + 5)
  head.writeUInt16BE(width, sof + 7)
  return `data:image/jpeg;base64,${head.toString('base64')}`
}

describe('parseImageDataUrlSize', () => {
  it('解析 PNG/JPEG/GIF/BMP/WebP 头部尺寸', () => {
    expect(parseImageDataUrlSize(pngDataUrl(1920, 911))).toEqual({ width: 1920, height: 911 })
    expect(parseImageDataUrlSize(jpegDataUrl(800, 600))).toEqual({ width: 800, height: 600 })
    const gif = Buffer.alloc(32); gif.write('GIF89a', 0, 'latin1'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(240, 8)
    expect(parseImageDataUrlSize(`data:image/gif;base64,${gif.toString('base64')}`)).toEqual({ width: 320, height: 240 })
    const bmp = Buffer.alloc(64); bmp[0] = 0x42; bmp[1] = 0x4d; bmp.writeInt32LE(1024, 18); bmp.writeInt32LE(768, 22)
    expect(parseImageDataUrlSize(`data:image/bmp;base64,${bmp.toString('base64')}`)).toEqual({ width: 1024, height: 768 })
    const webp = Buffer.alloc(64); webp.write('RIFF', 0, 'latin1'); webp.write('WEBP', 8, 'latin1'); webp.write('VP8X', 12, 'latin1')
    webp.writeUIntLE(639, 24, 3); webp.writeUIntLE(479, 27, 3)
    expect(parseImageDataUrlSize(`data:image/webp;base64,${webp.toString('base64')}`)).toEqual({ width: 640, height: 480 })
  })

  it('非 data URL / 无法识别的格式返回 null', () => {
    expect(parseImageDataUrlSize('https://example.com/a.png')).toBeNull()
    expect(parseImageDataUrlSize('data:image/svg+xml;base64,PHN2Zy8+')).toBeNull()
    expect(parseImageDataUrlSize('data:image/png;base64,AAAA')).toBeNull()
    expect(parseImageDataUrlSize('not-a-url')).toBeNull()
  })
})

describe('resolveImageBudgetRule', () => {
  it('minimax-m3 保持既有网格预留定额', () => {
    const rule = resolveImageBudgetRule('MiniMax-M3')!
    expect(rule('data:image/png;base64,AAAA')).toBeCloseTo((2016 / 14) ** 2 + 576, 5)
    expect(resolveImageBudgetRule('minimax-m3-turbo')).not.toBeNull()
    // 中继命名空间前缀：MiniMaxAI/MiniMax-M3 同样是 m3
    expect(resolveImageBudgetRule('MiniMaxAI/MiniMax-M3')).not.toBeNull()
  })

  it('qwen3.7-plus 命中 28px 合并 patch 公式', () => {
    // 1920×911 在 1536 token 像素上限下缩放后 ≈ 1539 token
    const url = pngDataUrl(1920, 911)
    const tokens = estimateImageBlockBudgetTokens('qwen3.7-plus', url)!
    expect(tokens).toBeGreaterThan(1000)
    expect(tokens).toBeLessThanOrEqual(1600)
    // 中继命名空间前缀与日期尾缀同样命中
    expect(estimateImageBlockBudgetTokens('Qwen/Qwen3.7-Plus', url)).toBe(tokens)
    expect(estimateImageBlockBudgetTokens('qwen3.7-plus-0906', url)).toBe(tokens)
  })

  it('qwen3.7-plus 尺寸解析失败时回退到族上限', () => {
    expect(estimateImageBlockBudgetTokens('qwen3.7-plus', 'https://example.com/a.png')).toBe(1536)
    expect(estimateImageBlockBudgetTokens('qwen3.7-plus', 'data:image/png;base64,AAAA')).toBe(1536)
  })

  it('未实测型号改用有界通用启发式（任意图片预算增量 ≤1536）', () => {
    for (const modelId of ['qwen-vl-max', 'qwen3.5-plus', 'Qwen3.5-397B-A17B', 'qwen3.7', 'qwen3.7-flash',
      'glm-4.6', 'deepseek-v4-flash', 'grok-4.5', 'mimo-v2.5']) {
      expect(resolveImageBudgetRule(modelId), modelId).not.toBeNull()
      expect(estimateImageBlockBudgetTokens(modelId, pngDataUrl(100, 100)), modelId).toBeLessThanOrEqual(1536)
    }
    // 尺寸解析失败 / 非常见格式回退到硬帽值
    expect(estimateImageBlockBudgetTokens('glm-4.6', 'https://example.com/a.png')).toBe(1536)
    expect(estimateImageBlockBudgetTokens('glm-4.6', 'data:image/png;base64,AAAA')).toBe(1536)
    // 1920×911 的缩放取整裸公式为 1539，通用口径必须被硬帽压住；qwen3.7-plus 保留裸值
    expect(estimateImageBlockBudgetTokens('grok-4.5', pngDataUrl(1920, 911))).toBe(1536)
    expect(estimateImageBlockBudgetTokens('qwen3.7-plus', pngDataUrl(1920, 911))!).toBeGreaterThan(1536)
    // 无模型 id 时调用方未提供路由身份，保持原口径
    expect(resolveImageBudgetRule(undefined)).toBeNull()
  })
})

describe('measureRequestBudget 图片计量', () => {
  const url = pngDataUrl(1920, 911) + 'A'.repeat(400_000) // 大 data URL：虚报路径下的重灾区
  const imageBody = {
    model: 'qwen3.7-plus',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url } }] }
    ]
  }
  const textBody = { model: 'qwen3.7-plus', messages: imageBody.messages.map((m, i) => i === 1 ? { role: 'user', content: '看图' } : m) }

  it('qwen 命中规则：budgetUnits 按公式而非 base64 文本计', () => {
    const withImage = measureRequestBudget(imageBody, 'route', 200_000)
    const withoutImage = measureRequestBudget(textBody, 'route', 200_000)
    const delta = withImage.budgetUnits! - withoutImage.budgetUnits!
    // 规则值约 1.5k 量级；若仍按 URL 文本计，delta 会是 10 万量级
    expect(delta).toBeGreaterThan(500)
    expect(delta).toBeLessThan(4_000)
  })

  it('未实测型号图片增量被有界通用口径压住（不再虚报两个数量级）', () => {
    const body = { ...imageBody, model: 'grok-4.5' }
    const withImage = measureRequestBudget(body, 'route', 200_000)
    const withoutImage = measureRequestBudget({ ...textBody, model: 'grok-4.5' }, 'route', 200_000)
    const delta = withImage.budgetUnits! - withoutImage.budgetUnits!
    // 视觉预留 ≤1536；余量来自图片块 JSON 结构自身的文本量（约 20 token）
    expect(delta).toBeGreaterThan(500)
    expect(delta).toBeLessThan(2_000)
  })

  it('图片计量只改 budgetUnits，不改请求哈希与字节数', () => {
    const a = measureRequestBudget(imageBody, 'route', 200_000)
    const b = measureRequestBudget(imageBody, 'route', 200_000)
    expect(a.prefixHashes).toEqual(b.prefixHashes)
    expect(a.envelopeHash).toBe(b.envelopeHash)
    // 计量不改写请求体：serializedBytes 就是真实序列化长度
    expect(a.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(imageBody), 'utf8'))
    // 无图与有图请求的前缀链逐位一致（计量不影响消息内容）
    const noImage = measureRequestBudget(textBody, 'route', 200_000)
    expect(a.prefixHashes[0]).toBe(noImage.prefixHashes[0])
  })
})

describe('estimateContextSize 图片计量', () => {
  const url = pngDataUrl(1920, 911) + 'A'.repeat(400_000)
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url } }] }
  ]

  it('命中模型规则时按规则值计；未实测型号同样有界，不传 modelId 保持原口径', () => {
    const withRule = estimateContextSize(messages, 'qwen3.7-plus')
    const legacy = estimateContextSize(messages)
    const unknown = estimateContextSize(messages, 'grok-4.5')
    expect(withRule.bytes).toBe(legacy.bytes)
    expect(legacy.tokens - withRule.tokens).toBeGreaterThan(90_000)
    expect(withRule.tokens).toBeLessThan(5_000)
    expect(unknown.tokens).toBeLessThan(5_000)
  })
})
