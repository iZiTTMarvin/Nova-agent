/**
 * bash 快照记账单测：内容未知的文件只登记跳过，不写空备份。
 * 保护：拒绝或回滚未知内容文件时不会把真实文件清空。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { recordCheckpointChanges } from '@runtime/tools/bash'
import type { WorkspaceSnapshot } from '@runtime/checkpoints/snapshot'
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

    const baseline: WorkspaceSnapshot = new Map([
      ['big.bin', { mtimeMs: 1000, size: 12345 }]
    ])
    const mtimes = new Map([['big.bin', 2000]])

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

    const baseline: WorkspaceSnapshot = new Map([
      ['gone.bin', { mtimeMs: 1000, size: 9999 }]
    ])
    const mtimes = new Map<string, number>()

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

    const baseline: WorkspaceSnapshot = new Map([
      ['empty.txt', { content: Buffer.alloc(0), mtimeMs: 1000, size: 0 }]
    ])
    const mtimes = new Map([['empty.txt', 2000]])

    await recordCheckpointChanges(baseline, mtimes, createContext(manager))

    const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
    expect(manifest!.modifiedFiles).toContain('empty.txt')
    expect(manifest!.skippedFiles ?? []).toHaveLength(0)
    expect(existsSync(join(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID, 'files', 'empty.txt'))).toBe(true)
  })
})
