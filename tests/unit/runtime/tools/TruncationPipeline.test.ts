import { describe, it, expect } from 'vitest'
import { createTruncationPipeline } from '../../../../src/runtime/tools/TruncationPipeline'

describe('TruncationPipeline', () => {
  it('空输入无截断', () => {
    const pipeline = createTruncationPipeline()
    const result = pipeline.apply('')
    expect(result.truncated).toBe(false)
    expect(result.output).toBe('')
    expect(result.meta).toBeUndefined()
  })

  it('10 行正常输入无截断', () => {
    const pipeline = createTruncationPipeline()
    const input = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
    const result = pipeline.apply(input)
    expect(result.truncated).toBe(false)
    expect(result.output).toBe(input)
    expect(result.meta).toBeUndefined()
  })

  it('300 行输入触发 matchCount 截断', () => {
    const pipeline = createTruncationPipeline()
    const input = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n')
    const result = pipeline.apply(input)
    expect(result.truncated).toBe(true)
    expect(result.meta?.truncatedAt).toBe('match_count')
    expect(result.meta?.shown).toBe(250)
    expect(result.meta?.total).toBe(300)
    expect(result.meta?.limit).toBe(250)
    expect(result.output.split('\n').length).toBe(250)
  })

  it('50 行但字节超 100KB 触发 byteSize 截断', () => {
    const pipeline = createTruncationPipeline()
    const longLine = 'x'.repeat(3000)
    const input = Array.from({ length: 50 }, () => longLine).join('\n')
    const result = pipeline.apply(input)
    expect(result.truncated).toBe(true)
    expect(result.meta?.truncatedAt).toBe('byte_size')
    expect(result.meta?.limit).toBe(Math.round(100_000 / 1024))
    expect(result.meta?.shown).toBeGreaterThan(0)
    expect(result.meta?.total).toBe(Math.round(Buffer.byteLength(input, 'utf-8') / 1024))
  })

  it('含 >1000 字符行触发 lineLength 截断', () => {
    const pipeline = createTruncationPipeline()
    const input = 'short line\n' + 'x'.repeat(1500) + '\nanother short'
    const result = pipeline.apply(input)
    expect(result.truncated).toBe(true)
    expect(result.meta?.truncatedAt).toBe('line_length')
    expect(result.meta?.limit).toBe(1000)
    expect(result.output).toContain('...[截断]')
  })

  it('自定义配置有效', () => {
    const pipeline = createTruncationPipeline({ maxMatchCount: 100 })
    const input = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join('\n')
    const result = pipeline.apply(input)
    expect(result.truncated).toBe(true)
    expect(result.meta?.truncatedAt).toBe('match_count')
    expect(result.meta?.shown).toBe(100)
    expect(result.meta?.limit).toBe(100)
  })

  it('组合场景：匹配数 + 字节同时超，先触发 matchCount', () => {
    const pipeline = createTruncationPipeline()
    const longLine = 'x'.repeat(500)
    const input = Array.from({ length: 300 }, () => longLine).join('\n')
    const result = pipeline.apply(input)
    expect(result.truncated).toBe(true)
    expect(result.meta?.truncatedAt).toBe('match_count')
  })

  it('byteSize 截断后仍执行 lineLength 检查', () => {
    const pipeline = createTruncationPipeline({ maxByteSize: 5000 })
    const longLine = 'x'.repeat(2000)
    const input = Array.from({ length: 10 }, () => longLine).join('\n')
    const result = pipeline.apply(input)
    expect(result.truncated).toBe(true)
    expect(result.meta?.truncatedAt).toBe('byte_size')
    expect(result.output).toContain('...[截断]')
  })
})
