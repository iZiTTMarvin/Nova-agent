import { describe, it, expect } from 'vitest'
import { resolveEdits } from '../../../../src/runtime/tools/editTool'

describe('resolveEdits', () => {
  const path = 'test.ts'

  it('精确匹配单个编辑', () => {
    const original = 'const x = 1\nconst y = 2\n'
    const edits = [{ oldText: 'const x = 1', newText: 'const x = 10' }]
    const resolved = resolveEdits(original, edits, path)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].actualOldText).toBe('const x = 1')
    expect(resolved[0].actualNewText).toBe('const x = 10')
    expect(resolved[0].startOffset).toBe(0)
  })

  it('精确匹配多个不重叠编辑', () => {
    const original = 'aaa\nbbb\nccc\n'
    const edits = [
      { oldText: 'aaa', newText: 'AAA' },
      { oldText: 'ccc', newText: 'CCC' },
    ]
    const resolved = resolveEdits(original, edits, path)
    expect(resolved).toHaveLength(2)
  })

  it('弯引号容错匹配', () => {
    const original = 'const s = \u201Chello\u201D\n'
    const edits = [{ oldText: 'const s = "hello"', newText: 'const s = "world"' }]
    const resolved = resolveEdits(original, edits, path)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].actualOldText).toBe('const s = \u201Chello\u201D')
  })

  it('脱敏标签还原匹配', () => {
    const original = '<function_results>data</function_results>\n'
    const edits = [{ oldText: '<fnr>data</fnr>', newText: '<fnr>new</fnr>' }]
    const resolved = resolveEdits(original, edits, path)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].actualOldText).toBe('<function_results>data</function_results>')
  })

  it('oldText 未找到时抛错', () => {
    const original = 'hello world\n'
    const edits = [{ oldText: 'not found', newText: 'x' }]
    expect(() => resolveEdits(original, edits, path)).toThrow('not found')
  })

  it('oldText 出现多次时拒绝', () => {
    const original = 'aaa\naaa\nbbb\n'
    const edits = [{ oldText: 'aaa', newText: 'xxx' }]
    expect(() => resolveEdits(original, edits, path)).toThrow('appears 2 times')
  })

  it('编辑点重叠时拒绝', () => {
    const original = 'abcdef\n'
    const edits = [
      { oldText: 'abcd', newText: 'XY' },
      { oldText: 'cdef', newText: 'ZW' },
    ]
    expect(() => resolveEdits(original, edits, path)).toThrow('overlap')
  })
})
