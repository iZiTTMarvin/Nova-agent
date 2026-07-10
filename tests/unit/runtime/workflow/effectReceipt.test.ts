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
  hashContent
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

  it('新建文件可删除；用户改过则 conflict；未跟踪文件不受影响', () => {
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
        afterHash
      })
    )

    // 用户改了 created
    writeFileSync(join(tmp, 'created.txt'), 'user-edited\n')
    const preview = previewRollback(tmp, runId)
    expect(preview.conflicts).toContain('created.txt')

    const result = confirmRollback(tmp, runId)
    expect(result.results.some((r) => r.path === 'created.txt' && r.status === 'conflict')).toBe(
      true
    )
    // 冲突文件不得被覆盖
    expect(readFileSync(join(tmp, 'created.txt'), 'utf-8')).toBe('user-edited\n')
    // 未跟踪文件仍在
    expect(existsSync(join(tmp, 'untracked.txt'))).toBe(true)
  })

  it('modify：当前仍为 afterHash 时可恢复；重复回滚幂等', () => {
    const runId = 'run2'
    writeFileSync(join(tmp, 'f.txt'), 'before\n')
    const beforeHash = hashContent('before\n')
    const backupDir = join(tmp, '.nova', 'compose', 'runs', runId, 'effect-backups')
    mkdirSync(backupDir, { recursive: true })
    const bak = join(backupDir, 'e1.bak')
    writeFileSync(bak, 'before\n')
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
        beforeCheckpointRef: bak,
        afterHash,
        effectId: 'e1'
      })
    )

    const r1 = confirmRollback(tmp, runId)
    expect(r1.results[0]?.status).toBe('restored')
    expect(readFileSync(join(tmp, 'f.txt'), 'utf-8')).toBe('before\n')

    // 重复回滚：已是 before 状态 → skipped
    const r2 = confirmRollback(tmp, runId)
    expect(r2.results[0]?.status).toBe('skipped')
  })
})
