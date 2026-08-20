import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBetterSqliteCodeGraph } from '@runtime/code-graph/graph/BetterSqliteCodeGraph'
import { runCodeGraphCacheGc } from '@runtime/code-graph/graph/CodeGraphCacheGc'
import {
  STRUCTURAL_RESOLVER_SIGNATURE,
  TREE_SITTER_PARSER_SIGNATURE
} from '@runtime/code-graph'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('CodeGraphCacheGc native metadata', () => {
  it('读取 index_meta.last_accessed 回收陈旧缓存并保护活动 workspace', async () => {
    const appDataPath = mkdtempSync(join(tmpdir(), 'nova-code-graph-native-gc-'))
    roots.push(appDataPath)
    const oldIdentity = '1111111111111111'
    const activeIdentity = '2222222222222222'
    const oldPath = await createIndex(appDataPath, oldIdentity, 100)
    const activePath = await createIndex(appDataPath, activeIdentity, 100)

    const result = await runCodeGraphCacheGc({
      appDataPath,
      activeWorkspaceIdentity: activeIdentity,
      retentionDays: 30,
      now: () => 31 * 24 * 60 * 60 * 1000
    })

    expect(result.removedWorkspaceIdentities).toEqual([oldIdentity])
    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(activePath)).toBe(true)
  })
})

async function createIndex(
  appDataPath: string,
  identity: string,
  now: number
): Promise<string> {
  const dbPath = join(appDataPath, 'code-graph', identity, 'index.db')
  const repository = openBetterSqliteCodeGraph({
    dbPath,
    workspaceIdentity: identity,
    parserSignature: TREE_SITTER_PARSER_SIGNATURE,
    resolverSignature: STRUCTURAL_RESOLVER_SIGNATURE,
    now: () => now
  })
  await repository.close()
  return join(appDataPath, 'code-graph', identity)
}
