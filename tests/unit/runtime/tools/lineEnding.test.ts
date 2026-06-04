import { describe, it, expect } from 'vitest'
import { stripBom, detectLineEnding, normalizeToLF, restoreLineEndings } from '../../../../src/runtime/tools/editTool'

describe('lineEnding', () => {
  describe('stripBom', () => {
    it('剥离 UTF-8 BOM', () => {
      const { bom, text } = stripBom('\uFEFFhello')
      expect(bom).toBe('\uFEFF')
      expect(text).toBe('hello')
    })

    it('无 BOM 时返回空', () => {
      const { bom, text } = stripBom('hello')
      expect(bom).toBe('')
      expect(text).toBe('hello')
    })
  })

  describe('detectLineEnding', () => {
    it('检测 CRLF', () => {
      expect(detectLineEnding('a\r\nb\r\n')).toBe('CRLF')
    })

    it('检测 LF', () => {
      expect(detectLineEnding('a\nb\n')).toBe('LF')
    })

    it('空字符串默认 LF', () => {
      expect(detectLineEnding('')).toBe('LF')
    })
  })

  describe('normalizeToLF', () => {
    it('CRLF 转 LF', () => {
      expect(normalizeToLF('a\r\nb\r\nc')).toBe('a\nb\nc')
    })

    it('LF 保持不变', () => {
      expect(normalizeToLF('a\nb\nc')).toBe('a\nb\nc')
    })
  })

  describe('restoreLineEndings', () => {
    it('恢复 CRLF', () => {
      expect(restoreLineEndings('a\nb\nc', 'CRLF')).toBe('a\r\nb\r\nc')
    })

    it('LF 不改变', () => {
      expect(restoreLineEndings('a\nb\nc', 'LF')).toBe('a\nb\nc')
    })

    it('往返一致', () => {
      const original = 'line1\r\nline2\r\nline3'
      const normalized = normalizeToLF(original)
      const restored = restoreLineEndings(normalized, 'CRLF')
      expect(restored).toBe(original)
    })
  })
})
