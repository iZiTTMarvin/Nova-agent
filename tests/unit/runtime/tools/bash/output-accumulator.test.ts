/**
 * output-accumulator.ts 单元测试
 *
 * 覆盖：小输出完整收集 / 大输出截断 + 临时文件 / UTF-8 跨 chunk / 行边界
 */
import { describe, it, expect } from 'vitest'
import { OutputAccumulator } from '@runtime/tools/bash/output-accumulator'

describe('OutputAccumulator', () => {
  it('小输出完整收集，不触发临时文件', () => {
    const acc = new OutputAccumulator({ maxBytes: 50_000 })
    acc.append(Buffer.from('hello\nworld\n', 'utf8'))
    acc.finish()
    const snap = acc.snapshot()
    expect(snap.truncated).toBe(false)
    expect(snap.content).toBe('hello\nworld\n')
    expect(snap.fullOutputPath).toBeUndefined()
  })

  it('超过 maxBytes 时触发截断并写入临时文件', async () => {
    const acc = new OutputAccumulator({ maxBytes: 1024 })
    // 写 2KB 数据
    const chunk = 'X'.repeat(2048)
    acc.append(Buffer.from(chunk, 'utf8'))
    acc.finish()
    const snap = acc.snapshot()
    expect(snap.truncated).toBe(true)
    expect(snap.fullOutputPath).toBeTruthy()

    await acc.closeTempFile()
  })

  it('截断后内容长度不超过 maxBytes', () => {
    const acc = new OutputAccumulator({ maxBytes: 100 })
    acc.append(Buffer.from('A'.repeat(500), 'utf8'))
    acc.finish()
    const snap = acc.snapshot()
    expect(snap.outputBytes).toBeLessThanOrEqual(100)
  })

  it('行边界安全：截断不产生半行', () => {
    const acc = new OutputAccumulator({ maxBytes: 20 })
    // 制造 5 行
    for (let i = 0; i < 5; i++) {
      acc.append(Buffer.from(`line${i}\n`))
    }
    acc.finish()
    const snap = acc.snapshot()
    // 截断后每一行都应该是完整行
    const lines = snap.content.split('\n').filter(l => l.length > 0)
    for (const line of lines) {
      expect(line).toMatch(/^line\d+$/)
    }
  })

  it('UTF-8 跨 chunk 不产生半字符', () => {
    const acc = new OutputAccumulator({ maxBytes: 50_000 })
    // "你好世界" 的 UTF-8 编码是 12 字节
    // 故意在多字节字符中间切分
    const full = '你好世界'
    const buf = Buffer.from(full, 'utf8')
    acc.append(buf.subarray(0, 3))  // 半个「好」
    acc.append(buf.subarray(3))     // 剩下
    acc.finish()
    const snap = acc.snapshot()
    expect(snap.content).toBe(full)
  })

  it('超过 maxLines 时按行截断', () => {
    const acc = new OutputAccumulator({ maxLines: 5, maxBytes: 1_000_000 })
    for (let i = 0; i < 20; i++) {
      acc.append(Buffer.from(`line${i}\n`))
    }
    acc.finish()
    const snap = acc.snapshot()
    expect(snap.truncated).toBe(true)
    expect(snap.truncatedBy).toBe('lines')
    // 保留最后 5 行
    expect(snap.content).toContain('line19')
  })

  it('getLastLineBytes 返回最后一行的字节数', () => {
    const acc = new OutputAccumulator()
    acc.append(Buffer.from('first\nsecond\nlast'))
    acc.finish()
    // 最后一行是 "last"，4 字节
    expect(acc.getLastLineBytes()).toBe(4)
  })

  it('targetDir 设置时溢出文件写入指定目录', async () => {
    const { mkdtempSync, rmSync, existsSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const dir = mkdtempSync(join(tmpdir(), 'nova-acc-target-'))
    try {
      const acc = new OutputAccumulator({ maxBytes: 512, targetDir: dir })
      acc.append(Buffer.from('X'.repeat(2048), 'utf8'))
      acc.finish()
      const snap = acc.snapshot()
      await acc.closeTempFile()
      expect(snap.fullOutputPath).toBeTruthy()
      expect(snap.fullOutputPath!.startsWith(dir)).toBe(true)
      expect(existsSync(snap.fullOutputPath!)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
