import { describe, it, expect } from 'vitest'
import { EditMatchError, findUniqueEditMatch } from '../../../../src/runtime/tools/editMatch'
import { resolveEdits } from '../../../../src/runtime/tools/editTool'

describe('findUniqueEditMatch', () => {
  describe('exact', () => {
    it('唯一精确匹配成功', () => {
      const result = findUniqueEditMatch('hello world', 'world', 'a.txt')
      expect(result).toEqual({
        span: 'world',
        matchedVia: 'exact',
        startOffset: 6,
      })
    })

    it('多处出现拒绝', () => {
      expect(() => findUniqueEditMatch('a a a', 'a', 'b.txt')).toThrow(EditMatchError)
      try {
        findUniqueEditMatch('a a a', 'a', 'b.txt')
      } catch (err) {
        expect(err).toBeInstanceOf(EditMatchError)
        expect((err as EditMatchError).code).toBe('not_unique')
      }
    })

    it('空 oldString 拒绝', () => {
      expect(() => findUniqueEditMatch('abc', '', 'b.txt')).toThrow(/must not be empty/)
    })
  })

  describe('line-trimmed', () => {
    it('缩进偏差唯一匹配成功', () => {
      const content = 'function f() {\n    return 1;\n}\n'
      const oldString = 'function f() {\n  return 1;\n}'
      const result = findUniqueEditMatch(content, oldString, 'f.ts')
      expect(result.matchedVia).toBe('line-trimmed')
      expect(result.span).toBe('function f() {\n    return 1;\n}')
    })

    it('多候选拒绝', () => {
      const content = 'function a() {\n  x;\n}\nfunction a() {\n   x;\n}\n'
      const oldString = 'function a() {\n    x;\n}'
      expect(() => findUniqueEditMatch(content, oldString, 'a.ts')).toThrow(/different line-trimmed candidates/)
    })

    it('候选 span 在全文多次出现拒绝', () => {
      const content = 'function a() {\n  x;\n}\nfunction a() {\n  x;\n}\n'
      const oldString = 'function a() {\n    x;\n}'
      expect(() => findUniqueEditMatch(content, oldString, 'a.ts')).toThrow(/occurs more than once/)
    })
  })

  describe('whitespace', () => {
    it('内部空白归一后唯一匹配成功', () => {
      const result = findUniqueEditMatch('const  x   =   1;', 'const x = 1;', 'w.ts')
      expect(result.matchedVia).toBe('whitespace')
      expect(result.span).toBe('const  x   =   1;')
    })

    it('多行 oldString 不折叠到单行', () => {
      expect(() => findUniqueEditMatch('header\nalpha beta\nfooter\n', 'alpha\nbeta', 'w.ts'))
        .toThrow(/not found/)
    })

    it('多候选拒绝', () => {
      const content = 'const  x = 1;\nconst   x = 1;\n'
      expect(() => findUniqueEditMatch(content, 'const x = 1;', 'w.ts'))
        .toThrow(/different whitespace candidates/)
    })
  })

  describe('escape', () => {
    it('字面转义与真实换行唯一匹配成功', () => {
      const result = findUniqueEditMatch('line1\nline2', 'line1\\nline2', 'e.ts')
      expect(result.matchedVia).toBe('escape')
      expect(result.span).toBe('line1\nline2')
    })

    it('多候选拒绝', () => {
      const content = 'alpha\nbeta\nalpha\nbeta'
      expect(() => findUniqueEditMatch(content, 'alpha\\nbeta', 'e.ts'))
        .toThrow(/occurs more than once|different escape candidates/)
    })
  })

  describe('模糊门控', () => {
    it('去空白后过短拒绝模糊', () => {
      expect(() => findUniqueEditMatch('a   b', 'a b', 's.ts')).toThrow(/too short/)
    })

    it('含 NUL 时拒绝模糊，exact 仍可用', () => {
      const nul = '\0'
      const content = `alpha${nul}needle here`
      const exact = findUniqueEditMatch(content, 'needle here', 'b.bin')
      expect(exact.matchedVia).toBe('exact')
      expect(() => findUniqueEditMatch(content, 'needle  here', 'b.bin')).toThrow(/looks binary/)
    })

    it('超大文件拒绝模糊，exact 仍可用', () => {
      const content = 'x'.repeat(1_000_001) + '\nunique anchor line\n'
      const exact = findUniqueEditMatch(content, 'unique anchor line', 'big.txt')
      expect(exact.matchedVia).toBe('exact')
      expect(() => findUniqueEditMatch(content, '  unique anchor line  ', 'big.txt'))
        .toThrow(/too large to fuzzy-match/)
    })
  })

  describe('不对称尺寸', () => {
    it('匹配 span 远大于 oldString 时拒绝', () => {
      // 行 trim 后可匹配，但文件行尾空白使 span 远大于 oldString（多行字符门控）
      const content = 'alpha' + ' '.repeat(600) + '\nbeta\n'
      const oldString = 'alpha\nbeta'
      expect(() => findUniqueEditMatch(content, oldString, 'd.ts')).toThrow(/much larger/)
    })
  })
})

describe('resolveEdits 与模糊匹配集成', () => {
  it('oldText === newText 拒绝', () => {
    expect(() => resolveEdits('abc', [{ oldText: 'abc', newText: 'abc' }], 't.ts'))
      .toThrow(/identical/)
  })

  it('模糊命中写入 matchedVia', () => {
    const content = 'function f() {\n    return 1;\n}\n'
    const resolved = resolveEdits(
      content,
      [{ oldText: 'function f() {\n  return 1;\n}', newText: 'function f() {\n    return 2;\n}' }],
      'f.ts',
    )
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.matchedVia).toBe('line-trimmed')
    expect(resolved[0]!.actualOldText).toBe('function f() {\n    return 1;\n}')
  })

  it('精确匹配 matchedVia 为 exact', () => {
    const resolved = resolveEdits('hello', [{ oldText: 'hello', newText: 'hi' }], 't.ts')
    expect(resolved[0]!.matchedVia).toBe('exact')
  })

  it('模糊未命中时回退弯引号归一化', () => {
    const resolved = resolveEdits(
      'say \u201Chello\u201D',
      [{ oldText: 'say "hello"', newText: 'say "world"' }],
      'q.ts',
    )
    expect(resolved[0]!.matchedVia).toBe('quote')
    expect(resolved[0]!.actualOldText).toBe('say \u201Chello\u201D')
  })

  it('模糊未命中时回退 XML 反序列化', () => {
    const resolved = resolveEdits(
      'before <function_results> after',
      [{ oldText: 'before <fnr> after', newText: 'before X after' }],
      'd.ts',
    )
    expect(resolved[0]!.matchedVia).toBe('desanitize')
    expect(resolved[0]!.actualOldText).toBe('before <function_results> after')
  })

  it('模糊歧义经 resolveEdits 硬拒绝', () => {
    const content = 'function a() {\n  x;\n}\nfunction a() {\n   x;\n}\n'
    expect(() => resolveEdits(
      content,
      [{ oldText: 'function a() {\n    x;\n}', newText: 'Y' }],
      'a.ts',
    )).toThrow(/different line-trimmed candidates/)
  })
})
