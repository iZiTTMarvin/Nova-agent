/**
 * 工作区写冲突辅助单测：结构化结果识别 + lease acquire。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WORKSPACE_CONFLICT_PREFIX,
  isWorkspaceConflictResult,
  workspaceConflictResult,
  acquireWriterLeaseOrConflict
} from '../../../../src/runtime/workspace/conflict'
import { writerLeaseRegistry } from '../../../../src/runtime/workspace/WriterLease'

describe('workspace conflict helpers', () => {
  beforeEach(() => {
    writerLeaseRegistry.resetForTests()
  })
  afterEach(() => {
    writerLeaseRegistry.resetForTests()
  })

  it('workspaceConflictResult 产出带前缀的结构化冲突', () => {
    const r = workspaceConflictResult('lease_timeout')
    expect(r.success).toBe(false)
    expect(r.output.startsWith(WORKSPACE_CONFLICT_PREFIX)).toBe(true)
    expect(isWorkspaceConflictResult(r)).toBe(true)
  })

  it('isWorkspaceConflictResult 对普通失败返回 false', () => {
    expect(isWorkspaceConflictResult({ success: false, output: '', error: 'x' })).toBe(false)
  })

  it('acquireWriterLeaseOrConflict 缺 runId/workspaceRoot 时放行', async () => {
    const r = await acquireWriterLeaseOrConflict({})
    expect(r).toBeNull()
  })

  it('拿到租约返回 null', async () => {
    const r = await acquireWriterLeaseOrConflict({ runId: 'runA', workspaceRoot: '/ws' })
    expect(r).toBeNull()
  })

  it('租约被持有时返回冲突结果（超时）', async () => {
    await writerLeaseRegistry.acquire('/ws', 'runA')
    const r = await acquireWriterLeaseOrConflict({
      runId: 'runB',
      workspaceRoot: '/ws',
      timeoutMs: 30
    })
    expect(r).not.toBeNull()
    if (r) expect(isWorkspaceConflictResult(r)).toBe(true)
  })
})
