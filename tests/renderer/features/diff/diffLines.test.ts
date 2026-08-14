// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  LARGE_PATCH_CHAR_THRESHOLD,
  MAX_TOKENIZED_LINE_LENGTH,
  countEntryChanges,
  selectDiffRenderPolicy
} from '../../../../src/renderer/features/diff/diffLines'
import type { DiffEntry } from '../../../../src/shared/diff/types'

describe('countEntryChanges', () => {
  it('只统计 +/- 前缀行，不含上下文', () => {
    const entry: DiffEntry = {
      filePath: 'a.ts',
      status: 'modified',
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 4,
          content: ' keep\n-del1\n-del2\n+add1\n+add2\n+add3'
        }
      ]
    }

    expect(countEntryChanges(entry)).toEqual({ additions: 3, deletions: 2 })
  })

  it('空 hunk content 计为 0', () => {
    const entry: DiffEntry = {
      filePath: 'b.ts',
      status: 'added',
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 0, content: '' }]
    }

    expect(countEntryChanges(entry)).toEqual({ additions: 0, deletions: 0 })
  })
})

describe('selectDiffRenderPolicy', () => {
  it('普通语法模式使用 Worker 和行内差异', () => {
    expect(selectDiffRenderPolicy(1024, true)).toEqual({
      disableWorkerPool: false,
      lineDiffType: 'word-alt',
      maxLineDiffLength: MAX_TOKENIZED_LINE_LENGTH,
      tokenizeMaxLineLength: MAX_TOKENIZED_LINE_LENGTH
    })
  })

  it('文本模式关闭 Worker、高亮和行内差异', () => {
    expect(selectDiffRenderPolicy(1024, false)).toEqual({
      disableWorkerPool: true,
      lineDiffType: 'none',
      maxLineDiffLength: 0,
      tokenizeMaxLineLength: 0
    })
  })

  it('超大 patch 自动降级为纯文本策略', () => {
    expect(selectDiffRenderPolicy(LARGE_PATCH_CHAR_THRESHOLD + 1, true)).toEqual({
      disableWorkerPool: true,
      lineDiffType: 'none',
      maxLineDiffLength: 0,
      tokenizeMaxLineLength: 0
    })
  })
})
