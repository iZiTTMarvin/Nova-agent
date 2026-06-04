import { describe, it, expect } from 'vitest'
import { desanitizeMatchString, applyCorrespondingDesanitization } from '../../../../src/runtime/tools/editTool'

describe('desanitizeMatch', () => {
  describe('desanitizeMatchString', () => {
    it('还原 <fnr> 标签', () => {
      const { result, applied } = desanitizeMatchString('<fnr>content</fnr>')
      expect(result).toBe('<function_results>content</function_results>')
      expect(applied).toHaveLength(2)
    })

    it('还原 <s> 标签', () => {
      const { result } = desanitizeMatchString('<s>system</s>')
      expect(result).toBe('<system>system</system>')
    })

    it('无匹配时不改变', () => {
      const { result, applied } = desanitizeMatchString('normal text')
      expect(result).toBe('normal text')
      expect(applied).toHaveLength(0)
    })

    it('多重还原', () => {
      const { result } = desanitizeMatchString('<n>foo</n> <o>bar</o>')
      expect(result).toBe('<name>foo</name> <output>bar</output>')
    })

    it('还原 Human/Assistant 标记', () => {
      const { result } = desanitizeMatchString('\n\nH: hello\n\nA: world')
      expect(result).toBe('\n\nHuman: hello\n\nAssistant: world')
    })
  })

  describe('applyCorrespondingDesanitization', () => {
    it('oldText 未变化时不改变 newText', () => {
      const result = applyCorrespondingDesanitization('new text', 'old text', 'old text')
      expect(result).toBe('new text')
    })

    it('反向应用脱敏到 newText', () => {
      const result = applyCorrespondingDesanitization(
        'replace with <fnr>new</fnr>',
        '<fnr>old</fnr>',
        '<function_results>old</function_results>',
      )
      expect(result).toBe('replace with <function_results>new</function_results>')
    })
  })
})
