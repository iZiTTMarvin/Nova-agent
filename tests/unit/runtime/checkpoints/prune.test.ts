import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pruneOldCheckpoints } from '../../../../src/runtime/checkpoints/prune'
import { writeManifest, readManifest } from '../../../../src/runtime/checkpoints/manifest'
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
    vi.restoreAllMocks()
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

  it('只有候选超过保留窗口才读取当前 active path', () => {
    const activePath = vi.fn(() => new Set(['a', 'b']))
    pruneOldCheckpoints(checkpointRoot, 'missing', 1, activePath)
    pruneOldCheckpoints(checkpointRoot, sessionId, 1, activePath)
    writeSessionManifest('a', 1)
    pruneOldCheckpoints(checkpointRoot, sessionId, 1, activePath)
    expect(activePath).not.toHaveBeenCalled()
    writeSessionManifest('b', 2)
    pruneOldCheckpoints(checkpointRoot, sessionId, 1, activePath)
    expect(activePath).toHaveBeenCalledTimes(1)
    expect(readManifest(checkpointRoot, sessionId, 'a')?.backupPruned).toBe(true)
    expect(fs.existsSync(join(checkpointRoot, sessionId, 'b', 'files'))).toBe(true)
  })

  it('重复清理不写盘且保留首次清理时间', () => {
    writeSessionManifest('old', 1)
    writeSessionManifest('new', 2)
    pruneOldCheckpoints(checkpointRoot, sessionId, 1)
    const before = readManifest(checkpointRoot, sessionId, 'old')
    const write = vi.spyOn(fs, 'writeFileSync')
    vi.spyOn(Date, 'now').mockReturnValue(123456789)
    pruneOldCheckpoints(checkpointRoot, sessionId, 1)
    expect(write).not.toHaveBeenCalled()
    expect(readManifest(checkpointRoot, sessionId, 'old')).toEqual(before)
  })

  it.each(['backupPruned', 'forwardPruned'] as const)('补全仅有 %s 的清理记录', flag => {
    writeSessionManifest('old', 1)
    writeSessionManifest('new', 2)
    const manifest = readManifest(checkpointRoot, sessionId, 'old')!
    manifest[flag] = true
    writeManifest(checkpointRoot, manifest)
    pruneOldCheckpoints(checkpointRoot, sessionId, 1)
    expect(readManifest(checkpointRoot, sessionId, 'old')).toMatchObject({
      backupPruned: true, forwardPruned: true, prunedAt: expect.any(Number)
    })
    expect(fs.existsSync(join(checkpointRoot, sessionId, 'old', 'files'))).toBe(false)
  })

  it.each(['files', 'forward'])('重新清理再次出现的 %s 目录', directory => {
    writeSessionManifest('old', 1)
    writeSessionManifest('new', 2)
    pruneOldCheckpoints(checkpointRoot, sessionId, 1)
    const path = join(checkpointRoot, sessionId, 'old', directory)
    fs.mkdirSync(path)
    fs.writeFileSync(join(path, 'backup.txt'), 'reappeared')
    pruneOldCheckpoints(checkpointRoot, sessionId, 1)
    expect(fs.existsSync(path)).toBe(false)
    expect(readManifest(checkpointRoot, sessionId, 'new')?.backupPruned).toBeUndefined()
  })

  it('路径切换后清理新路径过期项，保留边界和同时间戳顺序', () => {
    for (const id of ['a', 'b', 'c']) writeSessionManifest(id, 1)
    pruneOldCheckpoints(checkpointRoot, sessionId, 2, new Set(['a', 'b']))
    expect(['a', 'b', 'c'].map(id => readManifest(checkpointRoot, sessionId, id)?.backupPruned))
      .toEqual([undefined, undefined, undefined])
    pruneOldCheckpoints(checkpointRoot, sessionId, 1, new Set(['a', 'b']))
    expect(readManifest(checkpointRoot, sessionId, 'b')?.backupPruned).toBe(true)
    pruneOldCheckpoints(checkpointRoot, sessionId, 1, new Set(['a', 'c']))
    expect(readManifest(checkpointRoot, sessionId, 'c')?.backupPruned).toBe(true)
    expect(fs.existsSync(join(checkpointRoot, sessionId, 'a', 'files'))).toBe(true)
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
