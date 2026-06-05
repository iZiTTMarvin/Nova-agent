/**
 * truncate.ts 单元测试
 *
 * 覆盖：head/tail 双模式 + 行边界安全 + UTF-8 安全 + 单行超限
 */
import { describe, it, expect } from 'vitest'
import { truncateHead, truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '@runtime/tools/bash/truncate'

describe('truncate', () => {
  describe('truncateHead', () => {
    it('不触发截断时原样返回', () => {
      const result = truncateHead('hello\nworld', { maxLines: 100, maxBytes: 1000 })
      expect(result.truncated).toBe(false)
      expect(result.content).toBe('hello\nworld')
      expect(result.truncatedBy).toBeNull()
    })

    it('超出 maxLines 时按行截断', () => {
      const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
      const result = truncateHead(text, { maxLines: 3, maxBytes: 100_000 })
      expect(result.truncated).toBe(true)
      expect(result.truncatedBy).toBe('lines')
      expect(result.content).toBe('line 0\nline 1\nline 2')
      expect(result.outputLines).toBe(3)
    })

    it('超出 maxBytes 时按字节截断', () => {
      const text = 'a'.repeat(1000)
      const result = truncateHead(text, { maxLines: 100_000, maxBytes: 100 })
      expect(result.truncated).toBe(true)
      expect(result.truncatedBy).toBe('bytes')
      expect(result.outputBytes).toBeLessThanOrEqual(100)
    })

    it('单行超 maxBytes 时整行切到 maxBytes 字符数', () => {
      const text = 'x'.repeat(500)
      const result = truncateHead(text, { maxBytes: 50 })
      expect(result.lastLinePartial).toBe(true)
      expect(result.content.length).toBe(50)
    })
  })

  describe('truncateTail', () => {
    it('不触发截断时原样返回', () => {
      const text = 'foo\nbar'
      const result = truncateTail(text, { maxLines: 10, maxBytes: 1000 })
      expect(result.truncated).toBe(false)
      expect(result.content).toBe('foo\nbar')
    })

    it('保留最后 N 行（错误信息场景）', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
      const text = lines.join('\n')
      const result = truncateTail(text, { maxLines: 5, maxBytes: 1_000_000 })
      expect(result.truncated).toBe(true)
      expect(result.truncatedBy).toBe('lines')
      expect(result.content).toBe('line 95\nline 96\nline 97\nline 98\nline 99')
    })

    it('按 maxBytes 截断时保留尾部', () => {
      const text = 'A'.repeat(1000) + 'END'
      const result = truncateTail(text, { maxLines: 100_000, maxBytes: 50 })
      expect(result.truncated).toBe(true)
      expect(result.truncatedBy).toBe('bytes')
      // 必须以 'END' 结尾（尾部语义）
      expect(result.content.endsWith('END')).toBe(true)
    })

    it('行边界安全：输出始终在 \n 边界', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `L${i}`).join('\n')
      const result = truncateTail(lines, { maxLines: 3, maxBytes: 1_000_000 })
      expect(result.content).toBe('L47\nL48\nL49')
    })

    it('UTF-8 多字节字符不会被拆成半字符', () => {
      // 中文 + emoji 混合
      const text = 'A\nB\n你\n好\n🎉\nEND'
      // 强制触发字节截断
      const result = truncateTail(text, { maxLines: 100_000, maxBytes: 10 })
      // 截断后不应该是 "�" 半字符
      expect(result.content).not.toMatch(/\uFFFD/)
    })

    it('多行 + 末行超限：tail 模式保留末行尾部', () => {
      // 多行场景：前面几行短小可以装下，但最后一行本身超过 maxBytes
      // tail 语义下应保留"末行的尾部"（错误信息通常在末尾）
      const longTail = 'X'.repeat(500)
      const text = ['a', 'b', 'c', 'TAIL_BEGIN' + longTail + 'TAIL_END'].join('\n')
      const result = truncateTail(text, { maxLines: 100_000, maxBytes: 50 })
      expect(result.truncated).toBe(true)
      expect(result.lastLinePartial).toBe(true)
      // 必须以末行尾部结尾
      expect(result.content.endsWith('TAIL_END')).toBe(true)
      // 不应包含末行的开头（TAIL_BEGIN 在更前面，被切掉了）
      expect(result.content.includes('TAIL_BEGIN')).toBe(false)
    })
  })

  describe('默认值', () => {
    it('默认 maxLines = 2000', () => {
      expect(DEFAULT_MAX_LINES).toBe(2000)
    })

    it('默认 maxBytes = 50KB', () => {
      expect(DEFAULT_MAX_BYTES).toBe(50 * 1024)
    })
  })
})
