import { describe, it, expect } from 'vitest'
import { normalizeQuotes, findActualString, preserveQuoteStyle } from '../../../../src/runtime/tools/editTool'

describe('quoteNormalizer', () => {
  describe('normalizeQuotes', () => {
    it('弯双引号转直引号', () => {
      expect(normalizeQuotes('\u201Chello\u201D')).toBe('"hello"')
    })

    it('弯单引号转直引号', () => {
      expect(normalizeQuotes('\u2018hello\u2019')).toBe("'hello'")
    })

    it('混合引号', () => {
      expect(normalizeQuotes('\u201Ca\u201D and \u2018b\u2019')).toBe('"a" and \'b\'')
    })

    it('直引号不变', () => {
      expect(normalizeQuotes('"hello"')).toBe('"hello"')
    })
  })

  describe('findActualString', () => {
    it('精确匹配优先', () => {
      const result = findActualString('say "hello"', '"hello"')
      expect(result).toBe('"hello"')
    })

    it('弯引号归一化匹配', () => {
      const result = findActualString('say \u201Chello\u201D', '"hello"')
      expect(result).toBe('\u201Chello\u201D')
    })

    it('未找到返回 null', () => {
      const result = findActualString('no match here', 'xyz')
      expect(result).toBeNull()
    })

    it('弯单引号匹配', () => {
      const result = findActualString("it\u2019s fine", "it's fine")
      expect(result).toBe('it\u2019s fine')
    })
  })

  describe('preserveQuoteStyle', () => {
    it('无弯引号时直接返回', () => {
      const result = preserveQuoteStyle('"old"', '"old"', '"new"')
      expect(result).toBe('"new"')
    })

    it('保持弯双引号风格', () => {
      const result = preserveQuoteStyle('"old"', '\u201Cold\u201D', '"new"')
      expect(result).toContain('\u201C')
      expect(result).toContain('\u201D')
    })

    it('缩写词撇号保留', () => {
      const result = preserveQuoteStyle("don't", 'don\u2019t', "won't")
      expect(result).toContain("'")
    })
  })
})
