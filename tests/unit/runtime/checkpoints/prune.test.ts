import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pruneOldCheckpoints } from '../../../../src/runtime/checkpoints/prune'
import { writeManifest } from '../../../../src/runtime/checkpoints/manifest'
import type { CheckpointManifest } from '../../../../src/runtime/checkpoints/types'

/**
 * prune 单测：验证 active path 过滤只统计激活路径上的 manifest。
 */
describe('pruneOldCheckpoints active path filter', () => {
  const checkpointRoot = join(tmpdir(), `nova-prune-test-${Date.now()}`)
  const sessionId = 'sess_prune'

  function writeSessionManifest(messageId: string, createdAt: number): void {
    const manifest: CheckpointManifest = {
      sessionId,
      messageId,
      workspaceRoot: '/ws',
      createdFiles: [],
      modifiedFiles: [`${messageId}.txt`],
      deletedFiles: [],
      status: 'active',
      createdAt
    }
    writeManifest(checkpointRoot, manifest)
    const filesDir = join(checkpointRoot, sessionId, messageId, 'files')
    fs.mkdirSync(filesDir, { recursive: true })
    fs.writeFileSync(join(filesDir, 'backup.txt'), 'original')
  }

  beforeEach(() => {
    fs.mkdirSync(join(checkpointRoot, sessionId), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(checkpointRoot, { recursive: true, force: true })
  })

  it('无 activePath 过滤时按全会话 manifest 计数', () => {
    writeSessionManifest('m1', 1)
    writeSessionManifest('m2', 2)
    writeSessionManifest('m3', 3)

    pruneOldCheckpoints(checkpointRoot, sessionId, 1)

    expect(fs.existsSync(join(checkpointRoot, sessionId, 'm1', 'files'))).toBe(false)
    expect(fs.existsSync(join(checkpointRoot, sessionId, 'm2', 'files'))).toBe(false)
    expect(fs.existsSync(join(checkpointRoot, sessionId, 'm3', 'files'))).toBe(true)
  })

  it('有 activePath 过滤时非激活分支 manifest 不占保留名额', () => {
    writeSessionManifest('active_old', 1)
    writeSessionManifest('inactive_old', 2)
    writeSessionManifest('active_new', 3)

    pruneOldCheckpoints(
      checkpointRoot,
      sessionId,
      1,
      new Set(['active_old', 'active_new'])
    )

    // inactive_old 不应被 prune（不在 active path 计数里）
    expect(fs.existsSync(join(checkpointRoot, sessionId, 'inactive_old', 'files'))).toBe(true)
    // active_old 应被 prune（active path 上只保留 1 条最新的 active_new）
    expect(fs.existsSync(join(checkpointRoot, sessionId, 'active_old', 'files'))).toBe(false)
    expect(fs.existsSync(join(checkpointRoot, sessionId, 'active_new', 'files'))).toBe(true)
  })
})
