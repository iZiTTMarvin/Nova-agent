/**
 * source-bound 懒校验测试：指纹比对分流（变化/缺失 → needs_verification；无法验证 → 跳过不误杀）。
 * 全部使用注入的 fake repository 与 fake stat，不触真实 fs。
 */
import { describe, it, expect, vi } from 'vitest'
import { MemoryVerifier } from '../../../../../src/runtime/memory/lifecycle/MemoryVerifier'
import type { MemorySourceStatFn } from '../../../../../src/runtime/memory/lifecycle/MemoryVerifier'

const WORKSPACE = 'D:/ws/project'

function createVerifier(stat: MemorySourceStatFn) {
  const updateStatus = vi.fn(() => true)
  const verifier = new MemoryVerifier({ repository: { updateStatus }, stat })
  return { verifier, updateStatus }
}

const RECORD = {
  id: 'mem_1',
  source: { path: 'package.json', fingerprint: '1024-1700000000' }
}

describe('MemoryVerifier', () => {
  it('指纹一致 → verified，不写状态', () => {
    const { verifier, updateStatus } = createVerifier(() => ({ size: 1024, mtimeMs: 1700000000 }))
    expect(verifier.verify(RECORD, WORKSPACE)).toBe('verified')
    expect(updateStatus).not.toHaveBeenCalled()
  })

  it('指纹变化（size 或 mtime）→ stale 并标记 needs_verification', () => {
    const { verifier, updateStatus } = createVerifier(() => ({ size: 2048, mtimeMs: 1700000000 }))
    expect(verifier.verify(RECORD, WORKSPACE)).toBe('stale')
    expect(updateStatus).toHaveBeenCalledWith('mem_1', 'needs_verification')
  })

  it('mtime 取整后一致不误判', () => {
    const { verifier, updateStatus } = createVerifier(() => ({ size: 1024, mtimeMs: 1700000000.95 }))
    expect(verifier.verify(RECORD, WORKSPACE)).toBe('verified')
    expect(updateStatus).not.toHaveBeenCalled()
  })

  it('文件不存在（ENOENT）→ stale 并标记 needs_verification', () => {
    const { verifier, updateStatus } = createVerifier(() => {
      const err = new Error('no such file') as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    })
    expect(verifier.verify(RECORD, WORKSPACE)).toBe('stale')
    expect(updateStatus).toHaveBeenCalledWith('mem_1', 'needs_verification')
  })

  it('stat 其他异常（权限等）→ unverifiable 跳过，不误杀', () => {
    const { verifier, updateStatus } = createVerifier(() => {
      const err = new Error('permission denied') as Error & { code?: string }
      err.code = 'EACCES'
      throw err
    })
    expect(verifier.verify(RECORD, WORKSPACE)).toBe('unverifiable')
    expect(updateStatus).not.toHaveBeenCalled()
  })

  it('无 workspaceRoot、无来源绑定或路径越界 → unverifiable', () => {
    const { verifier, updateStatus } = createVerifier(() => ({ size: 1, mtimeMs: 1 }))
    expect(verifier.verify(RECORD, undefined)).toBe('unverifiable')
    expect(verifier.verify({ id: 'mem_2', source: null }, WORKSPACE)).toBe('unverifiable')
    expect(
      verifier.verify({ id: 'mem_3', source: { path: '../outside.txt', fingerprint: '1-1' } }, WORKSPACE)
    ).toBe('unverifiable')
    expect(
      verifier.verify({ id: 'mem_4', source: { path: 'C:/abs/escape.txt', fingerprint: '1-1' } }, WORKSPACE)
    ).toBe('unverifiable')
    expect(updateStatus).not.toHaveBeenCalled()
  })

  it('状态写回失败仍判 stale（下次检索重新校验）', () => {
    const { verifier } = createVerifier(() => ({ size: 2048, mtimeMs: 0 }))
    const failing = new MemoryVerifier({
      repository: {
        updateStatus: () => {
          throw new Error('db down')
        }
      },
      stat: () => ({ size: 1, mtimeMs: 1 })
    })
    expect(failing.verify(RECORD, WORKSPACE)).toBe('stale')
    expect(verifier.verify(RECORD, WORKSPACE)).toBe('stale')
  })
})
