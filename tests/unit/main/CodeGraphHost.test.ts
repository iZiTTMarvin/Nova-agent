import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  codeGraphRuntimeCountForTests,
  closeCodeGraphForWorkspace,
  ensureCodeGraphForWorkspace,
  getCodeContextQueryPort,
  resetCodeGraphHostForTests,
  setCodeGraphRuntimeFactoryForTests,
  type CodeGraphRuntimeHandle
} from '../../../src/main/services/CodeGraphHost'
import { createEmptyCodeContextPack } from '../../../src/runtime/code-graph/context'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() }
}))

describe('CodeGraphHost', () => {
  const roots: string[] = []

  afterEach(async () => {
    await resetCodeGraphHostForTests()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('同一工作区只装配一个 Runtime，切走时只关闭对应 handle', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'nova-code-graph-host-'))
    const secondWorkspace = join(workspace, 'second')
    mkdirSync(secondWorkspace)
    roots.push(workspace)
    const created: string[] = []
    const closed: string[] = []
    setCodeGraphRuntimeFactoryForTests((workspaceRoot) => {
      created.push(workspaceRoot)
      const handle: CodeGraphRuntimeHandle = {
        queryPort: {
          query: async () => createEmptyCodeContextPack({
            status: 'ready',
            intent: 'locate',
            summary: 'ready · locate · test',
            warnings: []
          })
        },
        start: async () => undefined,
        close: async () => {
          closed.push(workspaceRoot)
        }
      }
      return handle
    })

    const first = ensureCodeGraphForWorkspace(workspace)
    const reused = ensureCodeGraphForWorkspace(workspace)
    ensureCodeGraphForWorkspace(secondWorkspace)

    expect(reused).toBe(first)
    expect(getCodeContextQueryPort(workspace)).toBe(first)
    expect(created).toHaveLength(2)
    expect(codeGraphRuntimeCountForTests()).toBe(2)

    await closeCodeGraphForWorkspace(workspace)
    expect(closed).toEqual([created[0]])
    expect(codeGraphRuntimeCountForTests()).toBe(1)
    expect(getCodeContextQueryPort(workspace)).toBeNull()
  })
})
