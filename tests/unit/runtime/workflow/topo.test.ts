import { describe, it, expect } from 'vitest'
import { topoSort } from '../../../../src/runtime/workflow/topo'

describe('topoSort (Kahn)', () => {
  it('无依赖时全部同一批', () => {
    const batches = topoSort([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' }
    ])
    expect(batches).toHaveLength(1)
    expect(batches[0]!.map((t) => t.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('线性依赖拆成多批', () => {
    const batches = topoSort([
      { id: 'a', deps: [] },
      { id: 'b', deps: ['a'] },
      { id: 'c', deps: ['b'] }
    ])
    expect(batches.map((b) => b.map((t) => t.id))).toEqual([['a'], ['b'], ['c']])
  })

  it('菱形依赖：可并行的在同一批', () => {
    const batches = topoSort([
      { id: 'a', deps: [] },
      { id: 'b', deps: ['a'] },
      { id: 'c', deps: ['a'] },
      { id: 'd', deps: ['b', 'c'] }
    ])
    expect(batches[0]!.map((t) => t.id)).toEqual(['a'])
    expect(batches[1]!.map((t) => t.id).sort()).toEqual(['b', 'c'])
    expect(batches[2]!.map((t) => t.id)).toEqual(['d'])
  })

  it('空列表返回空', () => {
    expect(topoSort([])).toEqual([])
  })

  it('环不抛错，剩余节点作为最后一批', () => {
    const batches = topoSort([
      { id: 'a', deps: ['b'] },
      { id: 'b', deps: ['a'] }
    ])
    expect(batches.length).toBeGreaterThanOrEqual(1)
    const ids = batches.flat().map((t) => t.id).sort()
    expect(ids).toEqual(['a', 'b'])
  })

  it('忽略指向不存在任务的 deps', () => {
    const batches = topoSort([{ id: 'a', deps: ['ghost'] }, { id: 'b', deps: ['a'] }])
    expect(batches.map((b) => b.map((t) => t.id))).toEqual([['a'], ['b']])
  })
})
