import { describe, expect, it } from 'vitest'
import {
  collectTouchedFilesFromManifests,
  isTouchedFilesOverflowMarker
} from '../../../../src/runtime/checkpoints/collectTouchedFiles'

describe('collectTouchedFilesFromManifests', () => {
  it('合并 bash 记录的路径，忽略未覆盖的 messageId', () => {
    const files = collectTouchedFilesFromManifests(
      [
        {
          messageId: 'm1',
          createdFiles: ['src/a.ts'],
          modifiedFiles: ['src/b.ts'],
          deletedFiles: []
        },
        {
          messageId: 'm2',
          createdFiles: [],
          modifiedFiles: ['notes.md'],
          deletedFiles: ['old.txt']
        }
      ],
      new Set(['m1', 'm2'])
    )
    expect(files).toEqual(['src/a.ts', 'src/b.ts', 'notes.md', 'old.txt'])
  })

  it('超出上限时折成另 N 个文件', () => {
    const files = collectTouchedFilesFromManifests(
      [
        {
          messageId: 'm1',
          createdFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
          modifiedFiles: [],
          deletedFiles: []
        }
      ],
      new Set(['m1']),
      3
    )
    expect(files).toHaveLength(3)
    expect(files.slice(0, 2)).toEqual(['a.ts', 'b.ts'])
    expect(isTouchedFilesOverflowMarker(files[2]!)).toBe(true)
    expect(files[2]).toContain('2 个文件')
  })

  it('未覆盖的 messageId 不出现手改路径', () => {
    const files = collectTouchedFilesFromManifests(
      [
        {
          messageId: 'other',
          createdFiles: ['hand-edit.ts'],
          modifiedFiles: [],
          deletedFiles: []
        }
      ],
      new Set(['m1'])
    )
    expect(files).toEqual([])
  })
})
