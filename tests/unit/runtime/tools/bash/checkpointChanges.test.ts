/**
 * bash 快照记账单测：内容未知的文件只登记跳过，不写空备份。
 * 保护：拒绝或回滚未知内容文件时不会把真实文件清空。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { recordCheckpointChanges, refreshCheckpointBaseline } from '@runtime/tools/bash'
import { diffSnapshots, snapshotMtimes, type MtimeSnapshot, type WorkspaceSnapshot } from '@runtime/checkpoints/snapshot'
import { CheckpointManager } from '@runtime/checkpoints/CheckpointManager'
import { readManifest } from '@runtime/checkpoints/manifest'
import { createReadState } from '@runtime/tools/editTool'
import type { ToolContext } from '@runtime/tools/types'

const TMP = join(process.cwd(), '.test-bash-checkpoint-workspace')
const CHECKPOINT_ROOT = join(process.cwd(), '.test-bash-checkpoints')
const SESSION_ID = 'test-session'
const MESSAGE_ID = 'msg-001'

function createContext(manager: CheckpointManager): ToolContext {
  return {
    workingDir: TMP,
    checkpointManager: manager,
    readState: createReadState()
  } as ToolContext
}

describe('recordCheckpointChanges 内容未知分流', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
    rmSync(CHECKPOINT_ROOT, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    rmSync(CHECKPOINT_ROOT, { recursive: true, force: true })
  })

  it('修改的内容未知文件只进 skippedFiles，不进 modifiedFiles 且无备份', async () => {
    const manager = new CheckpointManager({
      checkpointDir: CHECKPOINT_ROOT,
      sessionId: SESSION_ID,
      workspaceRoot: TMP
    })
    manager.beginMessage(MESSAGE_ID)

    const baseline: WorkspaceSnapshot = {
      files: new Map([['big.bin', { mtimeMs: 1000, size: 12345 }]]),
      unreadable: new Set()
    }
    const mtimes: MtimeSnapshot = { mtimes: new Map([['big.bin', 2000]]), unreadable: new Set() }

    await recordCheckpointChanges(baseline, mtimes, createContext(manager))

    const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
    expect(manifest!.modifiedFiles).toHaveLength(0)
    expect(manifest!.deletedFiles).toHaveLength(0)
    expect(manifest!.skippedFiles).toHaveLength(1)
    expect(manifest!.skippedFiles![0]).toMatchObject({
      path: 'big.bin',
      reason: 'oversized',
      bytes: 12345
    })
    expect(existsSync(join(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID, 'files', 'big.bin'))).toBe(false)
  })

  it('删除的内容未知文件只进 skippedFiles，不进 deletedFiles', async () => {
    const manager = new CheckpointManager({
      checkpointDir: CHECKPOINT_ROOT,
      sessionId: SESSION_ID,
      workspaceRoot: TMP
    })
    manager.beginMessage(MESSAGE_ID)

    const baseline: WorkspaceSnapshot = {
      files: new Map([['gone.bin', { mtimeMs: 1000, size: 9999 }]]),
      unreadable: new Set()
    }
    const mtimes: MtimeSnapshot = { mtimes: new Map(), unreadable: new Set() }

    await recordCheckpointChanges(baseline, mtimes, createContext(manager))

    const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
    expect(manifest!.deletedFiles).toHaveLength(0)
    expect(manifest!.modifiedFiles).toHaveLength(0)
    expect(manifest!.skippedFiles).toHaveLength(1)
    expect(manifest!.skippedFiles![0]).toMatchObject({ path: 'gone.bin' })
  })

  it('合法空文件仍走正常备份，不被当作未知内容', async () => {
    const manager = new CheckpointManager({
      checkpointDir: CHECKPOINT_ROOT,
      sessionId: SESSION_ID,
      workspaceRoot: TMP
    })
    manager.beginMessage(MESSAGE_ID)

    const baseline: WorkspaceSnapshot = {
      files: new Map([['empty.txt', { content: Buffer.alloc(0), mtimeMs: 1000, size: 0 }]]),
      unreadable: new Set()
    }
    const mtimes: MtimeSnapshot = { mtimes: new Map([['empty.txt', 2000]]), unreadable: new Set() }
    writeFileSync(join(TMP, 'empty.txt'), 'now has content')

    await recordCheckpointChanges(baseline, mtimes, createContext(manager))

    const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
    expect(manifest!.modifiedFiles).toContain('empty.txt')
    expect(manifest!.skippedFiles ?? []).toHaveLength(0)
    expect(existsSync(join(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID, 'files', 'empty.txt'))).toBe(true)
  })

  it('mtime 变化但字节未变的文件不记为修改', async () => {
    const manager = new CheckpointManager({
      checkpointDir: CHECKPOINT_ROOT,
      sessionId: SESSION_ID,
      workspaceRoot: TMP
    })
    manager.beginMessage(MESSAGE_ID)
    writeFileSync(join(TMP, 'touched.txt'), 'same bytes')

    const baseline: WorkspaceSnapshot = {
      files: new Map([['touched.txt', { content: Buffer.from('same bytes'), mtimeMs: 1000, size: 10 }]]),
      unreadable: new Set()
    }
    const mtimes: MtimeSnapshot = { mtimes: new Map([['touched.txt', 2000]]), unreadable: new Set() }

    await recordCheckpointChanges(baseline, mtimes, createContext(manager))

    expect(readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)?.modifiedFiles ?? []).toHaveLength(0)
  })

  it('执行后扫描未知的路径不记为删除', async () => {
    const manager = new CheckpointManager({
      checkpointDir: CHECKPOINT_ROOT,
      sessionId: SESSION_ID,
      workspaceRoot: TMP
    })
    manager.beginMessage(MESSAGE_ID)

    const baseline: WorkspaceSnapshot = {
      files: new Map([['locked/a.txt', { content: Buffer.from('a'), mtimeMs: 1000, size: 1 }]]),
      unreadable: new Set()
    }
    const mtimes: MtimeSnapshot = { mtimes: new Map(), unreadable: new Set(['locked']) }

    await recordCheckpointChanges(baseline, mtimes, createContext(manager))

    const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
    expect(manifest?.deletedFiles ?? []).toHaveLength(0)
    expect(manifest?.skippedFiles ?? []).toHaveLength(0)
  })

  it('滚动基线保留暂不可读子树，恢复后补齐旧文件而不误判新建', async () => {
    mkdirSync(join(TMP, 'locked'), { recursive: true })
    writeFileSync(join(TMP, 'locked', 'known.txt'), 'new')
    writeFileSync(join(TMP, 'locked', 'previously-unreadable.txt'), 'existing')
    const baseline: WorkspaceSnapshot = {
      files: new Map([['locked/known.txt', { content: Buffer.from('old'), mtimeMs: 1000, size: 3 }]]),
      unreadable: new Set(['locked/previously-unreadable.txt'])
    }
    const unreadable: MtimeSnapshot = { mtimes: new Map(), unreadable: new Set(['locked']) }
    const retained = await refreshCheckpointBaseline(baseline, unreadable, TMP)
    expect(retained.files.get('locked/known.txt')?.content?.toString()).toBe('old')

    const current = await snapshotMtimes(TMP)
    expect(diffSnapshots(retained, current)).toEqual({
      modified: ['locked/known.txt'], added: [], deleted: []
    })
    const recovered = await refreshCheckpointBaseline(retained, current, TMP)
    expect(recovered.files.get('locked/known.txt')?.content?.toString()).toBe('new')
    expect(recovered.files.get('locked/previously-unreadable.txt')?.content?.toString()).toBe('existing')
    expect(recovered.unreadable.size).toBe(0)
  })
})
