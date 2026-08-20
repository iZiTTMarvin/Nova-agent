import { describe, expect, it, vi } from 'vitest'
import {
  compareDiscoveredCodeFile,
  planCodeGraphDrift
} from '@runtime/code-graph/indexing/CodeGraphDrift'
import type { CodeGraphFileRecord } from '@runtime/code-graph'
import type { DiscoveredCodeFile } from '@runtime/code-graph/indexing/FileDiscovery'

describe('CodeGraphDrift', () => {
  it('mtime 与大小未变时不读取内容', async () => {
    const readHash = vi.fn<(path: string) => Promise<string>>()
    await expect(compareDiscoveredCodeFile(
      discovered('src/a.ts', 10, 100),
      indexed('src/a.ts', 10, 100, 'hash-a'),
      readHash
    )).resolves.toEqual({ kind: 'unchanged' })
    expect(readHash).not.toHaveBeenCalled()
  })

  it('元数据变化但 hash 相同只更新 metadata', async () => {
    await expect(compareDiscoveredCodeFile(
      discovered('src/a.ts', 10, 200),
      indexed('src/a.ts', 10, 100, 'hash-a'),
      async () => 'hash-a'
    )).resolves.toEqual({
      kind: 'metadata-only',
      update: {
        path: 'src/a.ts',
        contentHash: 'hash-a',
        sizeBytes: 10,
        mtimeMs: 200
      }
    })
  })

  it('一次 drift 明确区分新增、内容变化、删除与 metadata-only', async () => {
    const plan = await planCodeGraphDrift([
      discovered('src/a.ts', 11, 200),
      discovered('src/c.ts', 5, 100),
      discovered('src/d.ts', 7, 200)
    ], [
      indexed('src/a.ts', 10, 100, 'old-a'),
      indexed('src/b.ts', 5, 100, 'hash-b'),
      indexed('src/d.ts', 7, 100, 'hash-d')
    ], async (path) => path === 'src/d.ts' ? 'hash-d' : 'new-a')

    expect(plan.changedFiles.map((file) => file.path)).toEqual(['src/a.ts', 'src/c.ts'])
    expect(plan.removedPaths).toEqual(['src/b.ts'])
    expect(plan.metadataUpdates).toEqual([{
      path: 'src/d.ts',
      contentHash: 'hash-d',
      sizeBytes: 7,
      mtimeMs: 200
    }])
  })
})

function discovered(
  path: string,
  sizeBytes: number,
  mtimeMs: number
): DiscoveredCodeFile {
  return { path, sizeBytes, mtimeMs, language: 'typescript', status: 'eligible' }
}

function indexed(
  path: string,
  sizeBytes: number,
  mtimeMs: number,
  contentHash: string
): CodeGraphFileRecord {
  return {
    id: 1,
    generation: 1,
    path,
    language: 'typescript',
    contentHash,
    sizeBytes,
    mtimeMs,
    lineCount: 1,
    parseStatus: 'parsed'
  }
}
