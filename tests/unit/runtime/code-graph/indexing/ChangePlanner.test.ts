import { describe, expect, it } from 'vitest'
import {
  CODE_INDEX_BULK_CHANGE_COUNT,
  mergeWorkspaceChanges,
  planWorkspaceChanges
} from '@runtime/code-graph/indexing/ChangePlanner'

describe('ChangePlanner', () => {
  it('同路径合并后保持稳定顺序且删除优先', () => {
    expect(mergeWorkspaceChanges([
      { type: 'add', path: 'src/z.ts' },
      { type: 'change', path: 'src/a.ts' },
      { type: 'unlink', path: 'src/a.ts' },
      { type: 'change', path: 'src/z.ts' }
    ])).toEqual([
      { type: 'unlink', path: 'src/a.ts' },
      { type: 'change', path: 'src/z.ts' }
    ])
  })

  it('配置变化与事件风暴转为 full rebuild', () => {
    expect(planWorkspaceChanges([
      { type: 'change', path: 'configs/tsconfig.app.json' }
    ], 500)).toMatchObject({ kind: 'full-rebuild', reason: 'config-change' })
    expect(planWorkspaceChanges(
      Array.from({ length: CODE_INDEX_BULK_CHANGE_COUNT }, (_, index) => ({
        type: 'change' as const,
        path: `src/file-${index}.ts`
      })),
      10_000
    )).toMatchObject({ kind: 'full-rebuild', reason: 'bulk-change' })
    expect(planWorkspaceChanges([
      { type: 'change', path: 'src/a.ts' },
      { type: 'change', path: 'src/b.ts' }
    ], 10)).toMatchObject({ kind: 'full-rebuild', reason: 'bulk-change' })
  })

  it('小批普通源码变化保留增量路径', () => {
    expect(planWorkspaceChanges([
      { type: 'change', path: 'src/a.ts' },
      { type: 'unlink', path: 'src/old.ts' }
    ], 100)).toEqual({
      kind: 'incremental',
      changes: [
        { type: 'change', path: 'src/a.ts' },
        { type: 'unlink', path: 'src/old.ts' }
      ]
    })
  })
})
