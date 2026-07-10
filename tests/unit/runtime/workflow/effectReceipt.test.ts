/**
 * FileEffectReceipt 安全回滚：不覆盖用户修改、不删无关未跟踪文件。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildFileEffectReceipt,
  recordFileEffect,
  previewRollback,
  confirmRollback,
  hashContent,
  resolveBackupRef
} from '../../../../src/runtime/workflow/v2/EffectReceipt'

describe('EffectReceipt 安全回滚', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-effect-rb-'))
  })

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('新建文件可删除；用户改过则 conflict 且 ok=false；未跟踪文件不受影响', () => {
    const runId = 'run1'
    writeFileSync(join(tmp, 'created.txt'), 'from-run\n')
    writeFileSync(join(tmp, 'untracked.txt'), 'user\n')

    const afterHash = hashContent('from-run\n')
    recordFileEffect(
      tmp,
      buildFileEffectReceipt({
        workspaceRoot: tmp,
        runId,
        absPath: join(tmp, 'created.txt'),
        action: 'create',
        beforeHash: null,
        beforeCheckpointRef: null,
        afterHash,
        status: 'committed'
      })
    )

    writeFileSync(join(tmp, 'created.txt'), 'user-edited\n')
    const preview = previewRollback(tmp, runId)
    expect(preview.conflicts).toContain('created.txt')

    const result = confirmRollback(tmp, runId, { previewToken: preview.previewToken })
    expect(result.ok).toBe(false)
    expect(result.results.some((r) => r.path === 'created.txt' && r.status === 'conflict')).toBe(
      true
    )
    expect(readFileSync(join(tmp, 'created.txt'), 'utf-8')).toBe('user-edited\n')
    expect(existsSync(join(tmp, 'untracked.txt'))).toBe(true)
  })

  it('modify：相对 backup 可恢复；绝对 beforeCheckpointRef 被拒绝', () => {
    const runId = 'run2'
    writeFileSync(join(tmp, 'f.txt'), 'before\n')
    const beforeHash = hashContent('before\n')
    const backupDir = join(tmp, '.nova', 'compose', 'runs', runId, 'effect-backups')
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, 'e1.bak'), 'before\n')
    writeFileSync(join(tmp, 'f.txt'), 'after\n')
    const afterHash = hashContent('after\n')

    recordFileEffect(
      tmp,
      buildFileEffectReceipt({
        workspaceRoot: tmp,
        runId,
        absPath: join(tmp, 'f.txt'),
        action: 'modify',
        beforeHash,
        beforeCheckpointRef: 'effect-backups/e1.bak',
        afterHash,
        effectId: 'e1',
        status: 'committed'
      })
    )

    expect(resolveBackupRef(tmp, runId, 'effect-backups/e1.bak')).toMatch(/e1\.bak$/)
    expect(() => resolveBackupRef(tmp, runId, join(tmp, 'evil.bak'))).toThrow()

    const preview = previewRollback(tmp, runId)
    const r1 = confirmRollback(tmp, runId, { previewToken: preview.previewToken })
    expect(r1.ok).toBe(true)
    expect(r1.results[0]?.status).toBe('restored')
    expect(readFileSync(join(tmp, 'f.txt'), 'utf-8')).toBe('before\n')

    const r2 = confirmRollback(tmp, runId)
    expect(r2.results[0]?.status).toBe('skipped')
  })

  it('同文件连续修改三次：preview 用虚拟状态逆序模拟', () => {
    const runId = 'run3'
    const backupDir = join(tmp, '.nova', 'compose', 'runs', runId, 'effect-backups')
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(tmp, 'm.txt'), 'v0\n')

    const versions = ['v0\n', 'v1\n', 'v2\n', 'v3\n']
    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(backupDir, `e${i}.bak`), versions[i - 1])
      writeFileSync(join(tmp, 'm.txt'), versions[i])
      recordFileEffect(
        tmp,
        buildFileEffectReceipt({
          workspaceRoot: tmp,
          runId,
          absPath: join(tmp, 'm.txt'),
          action: 'modify',
          beforeHash: hashContent(versions[i - 1]),
          beforeCheckpointRef: `effect-backups/e${i}.bak`,
          afterHash: hashContent(versions[i]),
          effectId: `e${i}`,
          status: 'committed'
        })
      )
    }

    const preview = previewRollback(tmp, runId)
    // 逆序三次 restore，最终应回到 v0
    expect(preview.willRestore.length).toBeGreaterThanOrEqual(1)
    const result = confirmRollback(tmp, runId, { previewToken: preview.previewToken })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(tmp, 'm.txt'), 'utf-8')).toBe('v0\n')
  })

  it('preview 后用户改文件，confirm 因 token 拒绝', () => {
    const runId = 'run4'
    writeFileSync(join(tmp, 't.txt'), 'a\n')
    const afterHash = hashContent('a\n')
    recordFileEffect(
      tmp,
      buildFileEffectReceipt({
        workspaceRoot: tmp,
        runId,
        absPath: join(tmp, 't.txt'),
        action: 'create',
        beforeHash: null,
        beforeCheckpointRef: null,
        afterHash,
        status: 'committed'
      })
    )
    const preview = previewRollback(tmp, runId)
    writeFileSync(join(tmp, 't.txt'), 'changed\n')
    const result = confirmRollback(tmp, runId, { previewToken: preview.previewToken })
    expect(result.ok).toBe(false)
    expect(result.results[0]?.reason).toMatch(/previewToken/)
  })

  it('恶意 ../ path 被拒绝', () => {
    expect(() =>
      recordFileEffect(
        tmp,
        buildFileEffectReceipt({
          workspaceRoot: tmp,
          runId: 'run5',
          absPath: join(tmp, '..', 'outside.txt'),
          action: 'create',
          beforeHash: null,
          beforeCheckpointRef: null,
          afterHash: 'x',
          status: 'committed'
        })
      )
    ).toThrow(/逃逸|拒绝/)
  })
})
