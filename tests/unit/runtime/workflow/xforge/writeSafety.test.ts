import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CheckpointManager } from '../../../../../src/runtime/checkpoints/CheckpointManager'
import {
  buildFileEffectReceipt,
  commitFileEffect,
  recordFileEffect
} from '../../../../../src/runtime/workflow/v2/EffectReceipt'
import {
  createWorkspaceFingerprint,
  getXForgeRunRoot,
  inspectXForgeTaskEffects,
  prepareXForgeWriteBoundary
} from '../../../../../src/runtime/workflow/xforge'

describe('XForge 写入安全事实层', () => {
  let workspaceRoot: string
  let checkpointRoot: string

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-xforge-workspace-'))
    checkpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-xforge-checkpoints-'))
  })

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
    fs.rmSync(checkpointRoot, { recursive: true, force: true })
  })

  it('Fingerprint 基于文件内容，不能被相同 size/mtime 冒充', () => {
    const file = path.join(workspaceRoot, 'a.txt')
    fs.writeFileSync(file, 'aa')
    const beforeStat = fs.statSync(file)
    const before = createWorkspaceFingerprint(workspaceRoot, { revision: 1 })

    fs.writeFileSync(file, 'bb')
    fs.utimesSync(file, beforeStat.atime, beforeStat.mtime)
    const after = createWorkspaceFingerprint(workspaceRoot, { revision: 1 })

    expect(after.digest).not.toBe(before.digest)
  })

  it('超出文件上限时拒绝生成截断 Fingerprint', () => {
    fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'a')
    fs.writeFileSync(path.join(workspaceRoot, 'b.txt'), 'b')
    expect(() => createWorkspaceFingerprint(workspaceRoot, { maxFiles: 1 })).toThrow(/不完整摘要/)
  })

  it('写入边界使用真实 CheckpointManager 事务并绑定权威 revision', () => {
    fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'a')
    const manager = new CheckpointManager({
      checkpointDir: checkpointRoot,
      sessionId: 'session-1',
      workspaceRoot
    })
    const boundary = prepareXForgeWriteBoundary({
      checkpointManager: manager,
      workspaceRoot,
      checkpointRef: 'xforge-run-implement',
      workspaceRevision: 8
    })

    expect(manager.getCurrentMessageId()).toBe('xforge-run-implement')
    expect(boundary.fingerprint).toMatchObject({ revision: 8 })
    expect(boundary.fingerprint.digest).toHaveLength(64)
  })

  it('只从持久化 Receipt 判定 prepared/committed 状态', () => {
    const runId = 'run-1'
    const target = path.join(workspaceRoot, 'a.txt')
    fs.writeFileSync(target, 'after')
    const receipt = buildFileEffectReceipt({
      workspaceRoot,
      runId,
      stepId: 'task-1',
      absPath: target,
      action: 'create',
      beforeHash: null,
      beforeCheckpointRef: null,
      afterHash: null,
      effectId: 'effect-1'
    })
    recordFileEffect(workspaceRoot, receipt)

    expect(inspectXForgeTaskEffects({ workspaceRoot, runId, taskId: 'task-1' }).pending).toHaveLength(1)
    commitFileEffect(workspaceRoot, runId, receipt.effectId, { afterHash: 'hash' })
    const committed = inspectXForgeTaskEffects({ workspaceRoot, runId, taskId: 'task-1' })
    expect(committed.pending).toEqual([])
    expect(committed.effects).toEqual([
      { path: 'a.txt', receiptId: 'effect-1', status: 'committed' }
    ])
  })

  it('拒绝 runId 路径逃逸', () => {
    expect(() => getXForgeRunRoot(workspaceRoot, '../escape')).toThrow(/非法 XForge runId/)
  })
})
