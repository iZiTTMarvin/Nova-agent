import { describe, it, expect } from 'vitest'
import {
  planReconcileDiff
} from '../../../../src/runtime/memory/MemoryReconciler'
import { computeFingerprint } from '../../../../src/runtime/memory/FtsQueryBuilder'
import type { ScannedMemoryFile } from '../../../../src/runtime/memory/types'

function file(relPath: string, body: string, fp: string): ScannedMemoryFile {
  return {
    relPath,
    body,
    fingerprint: fp,
    size: body.length,
    mtimeMs: 1
  }
}

describe('MemoryReconciler diff（P1-A3 纯逻辑）', () => {
  it('fingerprint = size-mtimeMs', () => {
    expect(computeFingerprint(120, 999)).toBe('120-999')
  })

  it('新增文件进入 added', () => {
    const disk = [file('MEMORY.md', 'new', '10-1')]
    const plan = planReconcileDiff(disk, new Map())
    expect(plan.added).toHaveLength(1)
    expect(plan.updated).toHaveLength(0)
    expect(plan.removed).toHaveLength(0)
  })

  it('指纹变化进入 updated', () => {
    const disk = [file('MEMORY.md', 'v2', '20-2')]
    const indexed = new Map([['MEMORY.md', '10-1']])
    const plan = planReconcileDiff(disk, indexed)
    expect(plan.updated).toHaveLength(1)
    expect(plan.added).toHaveLength(0)
  })

  it('指纹不变不产生 added/updated', () => {
    const disk = [file('MEMORY.md', 'same', '10-1')]
    const indexed = new Map([['MEMORY.md', '10-1']])
    const plan = planReconcileDiff(disk, indexed)
    expect(plan.added).toHaveLength(0)
    expect(plan.updated).toHaveLength(0)
    expect(plan.removed).toHaveLength(0)
  })

  it('磁盘缺失的索引项进入 removed', () => {
    const disk: ScannedMemoryFile[] = []
    const indexed = new Map([['old.md', '5-1']])
    const plan = planReconcileDiff(disk, indexed)
    expect(plan.removed).toEqual(['old.md'])
  })
})
