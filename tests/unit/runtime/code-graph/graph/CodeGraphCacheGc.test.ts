import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runCodeGraphCacheGc
} from '@runtime/code-graph/graph/CodeGraphCacheGc'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('CodeGraphCacheGc', () => {
  it('按保留期删除陈旧目录但永不删除活动 workspace', async () => {
    const appData = createRoot()
    const old = createCache(appData, '1111111111111111', 10)
    const active = createCache(appData, '2222222222222222', 20)
    const now = 40 * 24 * 60 * 60 * 1000
    const accessed = new Map([
      [old, 1],
      [active, 1]
    ])

    const result = await runCodeGraphCacheGc({
      appDataPath: appData,
      activeWorkspaceIdentity: '2222222222222222',
      now: () => now,
      readLastAccessed: (dbPath) => accessed.get(dbPath) ?? 0
    })

    expect(result.removedWorkspaceIdentities).toEqual(['1111111111111111'])
    expect(result.freedBytes).toBe(10)
    expect(result.retainedBytes).toBe(20)
  })

  it('容量超限时按 last_accessed 从旧到新继续删除', async () => {
    const appData = createRoot()
    const oldest = createCache(appData, '1111111111111111', 10)
    const newer = createCache(appData, '2222222222222222', 10)
    const newest = createCache(appData, '3333333333333333', 10)
    const accessed = new Map([
      [oldest, 100],
      [newer, 200],
      [newest, 300]
    ])

    const result = await runCodeGraphCacheGc({
      appDataPath: appData,
      activeWorkspaceIdentity: null,
      retentionDays: 10_000,
      maxBytes: 15,
      now: () => 400,
      readLastAccessed: (dbPath) => accessed.get(dbPath) ?? 0
    })

    expect(result.removedWorkspaceIdentities).toEqual([
      '1111111111111111',
      '2222222222222222'
    ])
    expect(result.retainedBytes).toBe(10)
  })

  it('损坏 metadata 只留诊断并把缓存按最旧项处理', async () => {
    const appData = createRoot()
    createCache(appData, '1111111111111111', 4)
    const result = await runCodeGraphCacheGc({
      appDataPath: appData,
      activeWorkspaceIdentity: null,
      retentionDays: 30,
      now: () => 31 * 24 * 60 * 60 * 1000,
      readLastAccessed: () => {
        throw new Error('corrupt')
      }
    })

    expect(result.removedWorkspaceIdentities).toEqual(['1111111111111111'])
    expect(result.diagnostics.join(' ')).toContain('metadata 不可读')
  })
})

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'nova-code-graph-gc-'))
  roots.push(root)
  return root
}

function createCache(appData: string, identity: string, bytes: number): string {
  const directory = join(appData, 'code-graph', identity)
  mkdirSync(directory, { recursive: true })
  const dbPath = join(directory, 'index.db')
  writeFileSync(dbPath, 'x'.repeat(bytes))
  return dbPath
}
