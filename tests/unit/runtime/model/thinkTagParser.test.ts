import { describe, it, expect } from 'vitest'
import { ThinkTagParser } from '../../../../src/runtime/model/ThinkTagParser'

const OPEN = '\x3Cthink\x3E'
const CLOSE = '\x3C/think\x3E'

describe('ThinkTagParser', () => {
  describe('基础场景', () => {
    it('纯文本不产出 thinking', () => {
      const parser = new ThinkTagParser()
      expect(parser.feed('hello world')).toEqual([
        { type: 'text', content: 'hello world' }
      ])
    })

    it('空字符串不产出任何内容', () => {
      const parser = new ThinkTagParser()
      expect(parser.feed('')).toEqual([])
    })

    it('完整 think 标签拆分为 text/thinking/text', () => {
      const parser = new ThinkTagParser()
      expect(parser.feed(`before${OPEN}hidden${CLOSE}after`)).toEqual([
        { type: 'text', content: 'before' },
        { type: 'thinking', content: 'hidden' },
        { type: 'text', content: 'after' }
      ])
    })

    it('纯 think 内容只有 thinking', () => {
      const parser = new ThinkTagParser()
      expect(parser.feed(`${OPEN}all thinking${CLOSE}`)).toEqual([
        { type: 'thinking', content: 'all thinking' }
      ])
    })

    it('空 think 标签合并为纯文本', () => {
      const parser = new ThinkTagParser()
      expect(parser.feed(`before${OPEN}${CLOSE}after`)).toEqual([
        { type: 'text', content: 'beforeafter' }
      ])
    })
  })

  describe('跨 chunk', () => {
    it('开始标签跨 chunk 正确拆分', () => {
      const parser = new ThinkTagParser()
      expect(parser.feed('hello\x3Cthin')).toEqual([
        { type: 'text', content: 'hello' }
      ])
      expect(parser.feed('k\x3Ehidden')).toEqual([
        { type: 'thinking', content: 'hidden' }
      ])
      expect(parser.feed('\x3C/thi')).toEqual([])
      expect(parser.feed('nk\x3Eafter')).toEqual([
        { type: 'text', content: 'after' }
      ])
    })

    it('标签在 chunk 边界精确切分', () => {
      const parser = new ThinkTagParser()
      expect(parser.feed('\x3Cth')).toEqual([])
      expect(parser.feed('ink\x3Econtent')).toEqual([
        { type: 'thinking', content: 'content' }
      ])
    })
  })

  describe('多标签', () => {
    it('多个 think 标签按顺序产出', () => {
      const parser = new ThinkTagParser()
      expect(parser.feed(`a${OPEN}t1${CLOSE}b${OPEN}t2${CLOSE}c`)).toEqual([
        { type: 'text', content: 'a' },
        { type: 'thinking', content: 't1' },
        { type: 'text', content: 'b' },
        { type: 'thinking', content: 't2' },
        { type: 'text', content: 'c' }
      ])
    })
  })

  describe('flush', () => {
    it('冲刷不完整的开始标签缓冲区', () => {
      const parser = new ThinkTagParser()
      parser.feed('hello\x3Cthin')
      expect(parser.flush()).toEqual([
        { type: 'text', content: '\x3Cthin' }
      ])
    })

    it('空缓冲区返回空数组', () => {
      const parser = new ThinkTagParser()
      parser.feed('hello')
      expect(parser.flush()).toEqual([])
    })

    it('不完整的闭合标签输出为 thinking', () => {
      const parser = new ThinkTagParser()
      parser.feed(`${OPEN}thinking\x3C/thi`)
      expect(parser.flush()).toEqual([
        { type: 'thinking', content: '\x3C/thi' }
      ])
    })

    it('thinking 状态无缓冲区时 flush 返回空', () => {
      const parser = new ThinkTagParser()
      parser.feed(`${OPEN}thinking content`)
      expect(parser.flush()).toEqual([])
    })
  })

  describe('边界情况', () => {
    it('内容中的 < 符号不触发误匹配', () => {
      const parser = new ThinkTagParser()
      expect(parser.feed('a \x3C b \x3C c')).toEqual([
        { type: 'text', content: 'a \x3C b \x3C c' }
      ])
    })

    it('类似但非 think 的标签输出为文本', () => {
      const parser = new ThinkTagParser()
      expect(parser.feed('\x3Cdiv\x3Ehello\x3C/div\x3E')).toEqual([
        { type: 'text', content: '\x3Cdiv\x3Ehello\x3C/div\x3E' }
      ])
    })

    it('think 内包含 < 正常输出为 thinking', () => {
      const parser = new ThinkTagParser()
      expect(parser.feed(`${OPEN}a \x3C b${CLOSE}`)).toEqual([
        { type: 'thinking', content: 'a \x3C b' }
      ])
    })
  })
})
