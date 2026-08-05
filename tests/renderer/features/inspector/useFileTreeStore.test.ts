import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  entryMatchesFilter,
  resetFileTreeStoreForTests,
  shouldForceExpand,
  useFileTreeStore
} from '../../../../src/renderer/features/inspector/useFileTreeStore'
import type { FsEntry } from '../../../../src/shared/fs/types'

describe('useFileTreeStore', () => {
  const mockInvoke = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    resetFileTreeStoreForTests()
    global.window = {
      ...global.window,
      api: {
        invoke: mockInvoke,
        on: vi.fn(() => () => {}),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis
  })

  it('懒加载缓存目录 entries', async () => {
    const rootEntries: FsEntry[] = [
      { name: 'src', relativePath: 'src', type: 'directory' },
      { name: 'readme.md', relativePath: 'readme.md', type: 'file' }
    ]
    mockInvoke.mockResolvedValueOnce({ entries: rootEntries })

    await useFileTreeStore.getState().loadDir('')
    expect(mockInvoke).toHaveBeenCalledWith('fs:list-directory', { relativeDir: '' })
    expect(useFileTreeStore.getState().nodes['']).toEqual(rootEntries)

    // 已缓存再次 load 仍会请求（显式 load）；toggleExpand 对已缓存目录不重复请求
    mockInvoke.mockClear()
    const childEntries: FsEntry[] = [
      { name: 'a.ts', relativePath: 'src/a.ts', type: 'file' }
    ]
    mockInvoke.mockResolvedValueOnce({ entries: childEntries })
    useFileTreeStore.getState().toggleExpand('src')
    await vi.waitFor(() => {
      expect(useFileTreeStore.getState().nodes['src']).toEqual(childEntries)
    })
    expect(mockInvoke).toHaveBeenCalledTimes(1)

    mockInvoke.mockClear()
    useFileTreeStore.getState().toggleExpand('src') // collapse
    useFileTreeStore.getState().toggleExpand('src') // expand again — cached
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(useFileTreeStore.getState().expanded['src']).toBe(true)
  })

  it('collapseAll 仅保留根展开', () => {
    useFileTreeStore.setState({
      expanded: { '': true, src: true, 'src/lib': true }
    })
    useFileTreeStore.getState().collapseAll()
    expect(useFileTreeStore.getState().expanded).toEqual({ '': true })
  })

  it('过滤：隐藏不匹配节点；目录有匹配后代则保留', () => {
    const nodes: Record<string, FsEntry[] | undefined> = {
      '': [
        { name: 'src', relativePath: 'src', type: 'directory' },
        { name: 'readme.md', relativePath: 'readme.md', type: 'file' }
      ],
      src: [
        { name: 'foo.ts', relativePath: 'src/foo.ts', type: 'file' },
        { name: 'bar.ts', relativePath: 'src/bar.ts', type: 'file' }
      ]
    }
    const src = nodes['']![0]
    const readme = nodes['']![1]
    expect(entryMatchesFilter(src, 'foo', nodes)).toBe(true)
    expect(entryMatchesFilter(readme, 'foo', nodes)).toBe(false)
    expect(entryMatchesFilter(src, 'readme', nodes)).toBe(false)
    expect(shouldForceExpand('src', 'foo', nodes)).toBe(true)
    expect(shouldForceExpand('src', 'zzz', nodes)).toBe(false)
  })

  it('IPC 失败写入 errors 并可重试', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('ENOENT'))
    await useFileTreeStore.getState().loadDir('gone')
    expect(useFileTreeStore.getState().errors['gone']).toBe('ENOENT')
    expect(useFileTreeStore.getState().loading['gone']).toBe(false)

    mockInvoke.mockResolvedValueOnce({ entries: [] })
    await useFileTreeStore.getState().loadDir('gone')
    expect(useFileTreeStore.getState().errors['gone']).toBeUndefined()
    expect(useFileTreeStore.getState().nodes['gone']).toEqual([])
  })
})
