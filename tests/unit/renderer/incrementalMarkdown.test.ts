/**
 * incrementalMarkdown 单元测试
 */
import { describe, expect, it } from 'vitest'
import {
  estimateParseCostChars,
  findOpenFenceStart,
  splitIncrementalMarkdown
} from '../../../src/renderer/features/chat/incrementalMarkdown'

describe('incrementalMarkdown', () => {
  it('未闭合 fence 时不把 fence 内内容封口', () => {
    const content = '# Title\n\n```ts\nconst x = 1\n'
    const split = splitIncrementalMarkdown(content, false, 0)
    expect(findOpenFenceStart(content)).toBeGreaterThanOrEqual(0)
    expect(split.activeTail).toContain('```ts')
    expect(split.sealedParts.join('')).not.toContain('```ts')
  })

  it('空行边界后封口 prefix，tail 只含未完成块', () => {
    const content = '第一段文字。\n\n第二段还在写'
    const split = splitIncrementalMarkdown(content, false, 0)
    expect(split.sealedEndOffset).toBeGreaterThan(0)
    expect(split.sealedParts.join('')).toContain('第一段')
    expect(split.activeTail).toContain('第二段')
  })

  it('isFinal 时全部封口', () => {
    const content = 'a\n\nb\n\nc'
    const split = splitIncrementalMarkdown(content, true, 0)
    expect(split.activeTail).toBe('')
    expect(split.sealedEndOffset).toBe(content.length)
  })

  it('100k 流式增长时每步 reparseChars 不随全文线性上升', () => {
    const paragraph = '这是一段用于压力测试的 Markdown 正文。\n\n'
    let content = ''
    let sealedEnd = 0
    const reparseSamples: number[] = []

    // 模拟逐步追加到约 100k
    while (content.length < 100_000) {
      content += paragraph
      const split = splitIncrementalMarkdown(content, false, sealedEnd)
      sealedEnd = split.sealedEndOffset
      const cost = estimateParseCostChars(split)
      reparseSamples.push(cost.reparseChars)
    }

    // 后半段样本的 reparse 中位数应远小于全文长度
    const mid = Math.floor(reparseSamples.length / 2)
    const late = reparseSamples.slice(mid)
    const lateMax = Math.max(...late)
    expect(content.length).toBeGreaterThanOrEqual(100_000)
    expect(lateMax).toBeLessThan(content.length * 0.15)
    // 且不应接近全文（防止退化成全文重解析）
    expect(lateMax).toBeLessThan(20_000)
  })

  it('sealedEnd 只前进不回退', () => {
    const a = 'AAA\n\nBBB'
    const s1 = splitIncrementalMarkdown(a, false, 0)
    const s2 = splitIncrementalMarkdown(a + ' 继续', false, s1.sealedEndOffset)
    expect(s2.sealedEndOffset).toBeGreaterThanOrEqual(s1.sealedEndOffset)
  })

  it('长未闭合 fence 流式时 scannedBytes 近似总输入（不平方）', () => {
    const prefix = 'intro\n\n```ts\n'
    let content = prefix
    let sealedEnd = 0
    let prevLen = 0
    let openFence = -1
    let totalScanned = 0

    // 追加约 100k 代码行，始终不闭合 fence
    while (content.length < 100_000) {
      content += 'const line = 1\n'
      const split = splitIncrementalMarkdown(content, false, sealedEnd, prevLen, openFence)
      sealedEnd = split.sealedEndOffset
      prevLen = content.length
      openFence = split.openFenceStart
      totalScanned += split.scannedBytes
    }

    expect(content.length).toBeGreaterThanOrEqual(100_000)
    expect(openFence).toBeGreaterThanOrEqual(0)
    // 有 prevOpenFenceStart 时每帧只扫增量后缀；累计应接近总输入而非 O(n²)
    expect(totalScanned).toBeLessThan(content.length * 2.5)
    expect(totalScanned).toBeGreaterThan(content.length * 0.5)
  })
})
