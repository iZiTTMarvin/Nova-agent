/**
 * 写者租约接入工具的单测：edit / write 在租约被其它 run 持有时返回 WORKSPACE_CONFLICT。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { editTool, createReadState } from '../../../../src/runtime/tools/editTool'
import { readTool } from '../../../../src/runtime/tools/readTool'
import { writeTool } from '../../../../src/runtime/tools/writeTool'
import { writerLeaseRegistry } from '../../../../src/runtime/workspace/WriterLease'
import type { ToolContext } from '../../../../src/runtime/tools/types'

const TMP = join(process.cwd(), '.test-workspace-lease')

describe('写者租约接入 edit / write', () => {
  let readState = createReadState()

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
    readState = createReadState()
    writerLeaseRegistry.resetForTests()
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    writerLeaseRegistry.resetForTests()
  })

  function createContext(runId: string): ToolContext {
    return {
      workingDir: TMP,
      workspaceRoot: TMP,
      runId,
      readState
    }
  }

  it('write：同一 run 持有租约后写通过（幂等）', async () => {
    await writerLeaseRegistry.acquire(TMP, 'runA')
    const result = await writeTool.execute(
      { path: 'ok.txt', content: 'hello' },
      createContext('runA')
    )
    expect(result.success).toBe(true)
  })

  it('write：同一 run 持有租约后另一 run 写会等待（验证接入路径不抛错）', async () => {
    // runA 持有租约，runB 的写会进入等待队列；此处不等待超时，
    // 只验证：runA 写通过 + runB 的写 Promise 处于 pending（未 reject、未 resolve）
    await writerLeaseRegistry.acquire(TMP, 'runA')
    const aResult = await writeTool.execute(
      { path: 'ok.txt', content: 'hello' },
      createContext('runA')
    )
    expect(aResult.success).toBe(true)

    // runB 发起写（会等待租约），用 Promise.race 探测它确实在等待而非立即失败
    const bPromise = writeTool.execute(
      { path: 'blocked.txt', content: 'x' },
      createContext('runB')
    )
    const settled = await Promise.race([
      bPromise.then(() => 'settled'),
      new Promise<'pending'>(r => setTimeout(() => r('pending'), 200))
    ])
    expect(settled).toBe('pending')
    // 释放 runA 让 runB 完成，避免泄露
    writerLeaseRegistry.release('runA')
    await bPromise
  })

  it('edit：同一 run 持有租约后编辑通过', async () => {
    writeFileSync(join(TMP, 'e.ts'), 'original\n')
    await readTool.execute({ path: 'e.ts' }, createContext('runA'))
    await writerLeaseRegistry.acquire(TMP, 'runA')
    const result = await editTool.execute(
      { filePath: 'e.ts', edits: [{ oldText: 'original', newText: 'changed' }] },
      createContext('runA')
    )
    expect(result.success).toBe(true)
  })

  it('无 runId / workspaceRoot 时放行（向后兼容）', async () => {
    const result = await writeTool.execute(
      { path: 'compat.txt', content: 'x' },
      { workingDir: TMP, readState }
    )
    expect(result.success).toBe(true)
  })
})
