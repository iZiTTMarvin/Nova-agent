import { describe, it, expect } from 'vitest'
import { lineDiff, renderLineDiff, computeFirstChangedLine, generateUnifiedPatch, extractSnippet } from '../../../../src/runtime/tools/editDiff'
import type { ResolvedEdit } from '../../../../src/runtime/tools/editTool'

describe('editDiff', () => {
  describe('lineDiff', () => {
    it('无变更时全部为空格', () => {
      const diff = lineDiff('a\nb\nc', 'a\nb\nc')
      expect(diff.every(d => d.op === ' ')).toBe(true)
    })

    it('检测添加行', () => {
      const diff = lineDiff('a\nc', 'a\nb\nc')
      const added = diff.filter(d => d.op === '+')
      expect(added).toHaveLength(1)
      expect(added[0].line).toBe('b')
    })

    it('检测删除行', () => {
      const diff = lineDiff('a\nb\nc', 'a\nc')
      const removed = diff.filter(d => d.op === '-')
      expect(removed).toHaveLength(1)
      expect(removed[0].line).toBe('b')
    })

    it('检测修改行', () => {
      const diff = lineDiff('a\nb\nc', 'a\nB\nc')
      const removed = diff.filter(d => d.op === '-')
      const added = diff.filter(d => d.op === '+')
      expect(removed).toHaveLength(1)
      expect(added).toHaveLength(1)
    })
  })

  describe('renderLineDiff', () => {
    it('输出 git diff 风格', () => {
      const diff = lineDiff('a\nb', 'a\nc')
      const rendered = renderLineDiff(diff)
      expect(rendered).toContain(' a')
      expect(rendered).toContain('-b')
      expect(rendered).toContain('+c')
    })
  })

  describe('computeFirstChangedLine', () => {
    it('第一行变更返回 1', () => {
      expect(computeFirstChangedLine('a', 'b')).toBe(1)
    })

    it('第三行变更返回 3', () => {
      expect(computeFirstChangedLine('a\nb\nc', 'a\nb\nd')).toBe(3)
    })

    it('无变更返回 1', () => {
      expect(computeFirstChangedLine('a\nb', 'a\nb')).toBe(1)
    })
  })

  describe('generateUnifiedPatch', () => {
    it('生成标准 unified diff header', () => {
      const patch = generateUnifiedPatch('test.ts', 'a\nb\nc', 'a\nB\nc')
      expect(patch).toContain('--- a/test.ts')
      expect(patch).toContain('+++ b/test.ts')
      expect(patch).toContain('@@')
    })

    it('无变更返回空字符串', () => {
      const patch = generateUnifiedPatch('test.ts', 'a\nb', 'a\nb')
      expect(patch).toBe('')
    })
  })

  describe('extractSnippet', () => {
    it('提取编辑点周围行', () => {
      const newContent = 'line1\nline2\nline3\nLINE4\nline5\nline6\nline7'
      const resolved: ResolvedEdit[] = [{
        index: 0,
        originalOldText: 'line4',
        actualOldText: 'line4',
        actualNewText: 'LINE4',
        startOffset: 18,
      }]
      const snippet = extractSnippet(newContent, resolved, 2)
      expect(snippet).toContain('line2')
      expect(snippet).toContain('LINE4')
      expect(snippet).toContain('line6')
    })
  })
})
