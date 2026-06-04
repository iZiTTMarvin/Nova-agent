import { describe, it, expect } from 'vitest'
import { decodeFileBuffer, encodeFile } from '../../../../src/runtime/tools/editDiff'

describe('fileEncoding', () => {
  describe('decodeFileBuffer', () => {
    it('检测 UTF-8 无 BOM', () => {
      const buf = Buffer.from('hello world', 'utf-8')
      const { text, encoding } = decodeFileBuffer(buf)
      expect(encoding).toBe('utf-8')
      expect(text).toBe('hello world')
    })

    it('检测 UTF-8 BOM', () => {
      const bom = Buffer.from([0xEF, 0xBB, 0xBF])
      const content = Buffer.from('hello', 'utf-8')
      const buf = Buffer.concat([bom, content])
      const { text, encoding } = decodeFileBuffer(buf)
      expect(encoding).toBe('utf-8-bom')
      expect(text).toBe('\uFEFFhello')
    })

    it('检测 UTF-16LE BOM', () => {
      const bom = Buffer.from([0xFF, 0xFE])
      const content = Buffer.from('hi', 'utf16le')
      const buf = Buffer.concat([bom, content])
      const { text, encoding } = decodeFileBuffer(buf)
      expect(encoding).toBe('utf-16le')
      expect(text).toBe('hi')
    })

    it('检测 UTF-16BE BOM', () => {
      const bom = Buffer.from([0xFE, 0xFF])
      const le = Buffer.from('hi', 'utf16le')
      const swapped = Buffer.alloc(le.length)
      for (let i = 0; i < le.length; i += 2) {
        swapped[i] = le[i + 1]
        swapped[i + 1] = le[i]
      }
      const buf = Buffer.concat([bom, swapped])
      const { text, encoding } = decodeFileBuffer(buf)
      expect(encoding).toBe('utf-16be')
      expect(text).toBe('hi')
    })

    it('纯 ASCII 识别为 UTF-8', () => {
      const buf = Buffer.from('const x = 1;', 'utf-8')
      const { encoding } = decodeFileBuffer(buf)
      expect(encoding).toBe('utf-8')
    })

    it('空 buffer 识别为 UTF-8', () => {
      const buf = Buffer.alloc(0)
      const { text, encoding } = decodeFileBuffer(buf)
      expect(encoding).toBe('utf-8')
      expect(text).toBe('')
    })
  })

  describe('encodeFile', () => {
    it('UTF-8 往返一致', () => {
      const original = 'hello 世界'
      const buf = encodeFile(original, 'utf-8')
      expect(buf.toString('utf-8')).toBe(original)
    })

    it('UTF-8 BOM 往返一致', () => {
      const original = 'hello'
      const buf = encodeFile(original, 'utf-8-bom')
      expect(buf[0]).toBe(0xEF)
      expect(buf[1]).toBe(0xBB)
      expect(buf[2]).toBe(0xBF)
      expect(buf.subarray(3).toString('utf-8')).toBe(original)
    })

    it('UTF-16LE 往返包含 BOM', () => {
      const buf = encodeFile('hi', 'utf-16le')
      expect(buf[0]).toBe(0xFF)
      expect(buf[1]).toBe(0xFE)
    })

    it('Latin-1 往返', () => {
      const original = 'caf\u00E9'
      const buf = encodeFile(original, 'latin-1')
      expect(buf.toString('latin1')).toBe(original)
    })
  })
})
