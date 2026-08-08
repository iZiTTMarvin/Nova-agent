import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildSessionDiffState } from '../../../../src/runtime/checkpoints/sessionDiffState'
import { writeManifest, getFilesDir } from '../../../../src/runtime/checkpoints/manifest'
import type { CheckpointManifest } from '../../../../src/runtime/checkpoints/types'
import { countEntryChanges } from '../../../../src/shared/diff/compute'

let tmpDir: string
let checkpointRoot: string
let workspaceRoot: string
const sessionId = 'sess_session_diff'

function writeWorkspaceFile(relPath: string, content: string): void {
  const absPath = path.join(workspaceRoot, relPath)
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(absPath, content, 'utf8')
}

function writeBackupFile(messageId: string, relPath: string, content: string): void {
  const filesDir = getFilesDir(checkpointRoot, sessionId, messageId)
  const backupPath = path.join(filesDir, relPath)
  fs.mkdirSync(path.dirname(backupPath), { recursive: true })
  fs.writeFileSync(backupPath, content, 'utf8')
}

function writeManifestAt(
  messageId: string,
  createdAt: number,
  partial: Partial<CheckpointManifest>
): void {
  writeManifest(checkpointRoot, {
    sessionId,
    messageId,
    workspaceRoot,
    createdFiles: [],
    modifiedFiles: [],
    deletedFiles: [],
    status: 'active',
    createdAt,
    ...partial
  })
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-session-diff-'))
  checkpointRoot = path.join(tmpDir, 'checkpoints')
  workspaceRoot = path.join(tmpDir, 'workspace')
  fs.mkdirSync(checkpointRoot, { recursive: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('buildSessionDiffState', () => {
  it('多消息同文件改动合并：取最早 manifest 的 backup 与当前工作区对比', () => {
    writeWorkspaceFile('src/merge.ts', 'line C')
    writeBackupFile('msg_1', 'src/merge.ts', 'line A')
    writeBackupFile('msg_2', 'src/merge.ts', 'line B')
    writeManifestAt('msg_1', 1000, { modifiedFiles: ['src/merge.ts'] })
    writeManifestAt('msg_2', 2000, { modifiedFiles: ['src/merge.ts'] })

    const state = buildSessionDiffState(checkpointRoot, workspaceRoot, sessionId)

    expect(state.diffs).toHaveLength(1)
    expect(state.diffs[0]).toMatchObject({ filePath: 'src/merge.ts', status: 'modified' })
    expect(countEntryChanges(state.diffs[0]!)).toEqual({ additions: 1, deletions: 1 })
    expect(state.messageIdByFile['src/merge.ts']).toBe('msg_1')
  })

  it('先建后改：原始内容视为空，聚合为 added 且路由到最早消息', () => {
    writeWorkspaceFile('src/new.ts', 'first\nsecond')
    writeBackupFile('msg_2', 'src/new.ts', 'first')
    writeManifestAt('msg_1', 1000, { createdFiles: ['src/new.ts'] })
    writeManifestAt('msg_2', 2000, { modifiedFiles: ['src/new.ts'] })

    const state = buildSessionDiffState(checkpointRoot, workspaceRoot, sessionId)

    expect(state.diffs).toHaveLength(1)
    expect(state.diffs[0]).toMatchObject({ filePath: 'src/new.ts', status: 'added' })
    expect(countEntryChanges(state.diffs[0]!)).toEqual({ additions: 2, deletions: 0 })
    expect(state.messageIdByFile['src/new.ts']).toBe('msg_1')
  })

  it('先建后删：净变化为零，不产生 diff', () => {
    writeManifestAt('msg_1', 1000, { createdFiles: ['src/gone.ts'] })
    writeManifestAt('msg_2', 2000, { deletedFiles: ['src/gone.ts'] })

    const state = buildSessionDiffState(checkpointRoot, workspaceRoot, sessionId)

    expect(state.diffs).toHaveLength(0)
    expect(state.messageIdByFile).toEqual({})
  })

  it('先改后删：以最早 backup 为原始内容，聚合为 deleted', () => {
    writeBackupFile('msg_1', 'src/removed.ts', 'original line')
    writeBackupFile('msg_2', 'src/removed.ts', 'modified line')
    writeManifestAt('msg_1', 1000, { modifiedFiles: ['src/removed.ts'] })
    writeManifestAt('msg_2', 2000, { deletedFiles: ['src/removed.ts'] })

    const state = buildSessionDiffState(checkpointRoot, workspaceRoot, sessionId)

    expect(state.diffs).toHaveLength(1)
    expect(state.diffs[0]).toMatchObject({ filePath: 'src/removed.ts', status: 'deleted' })
    expect(countEntryChanges(state.diffs[0]!)).toEqual({ additions: 0, deletions: 1 })
    expect(state.messageIdByFile['src/removed.ts']).toBe('msg_1')
  })

  it('删后重建：聚合为 modified（原始内容来自最早 backup）', () => {
    writeWorkspaceFile('src/again.ts', 'new life')
    writeBackupFile('msg_1', 'src/again.ts', 'old life')
    writeManifestAt('msg_1', 1000, { deletedFiles: ['src/again.ts'] })
    writeManifestAt('msg_2', 2000, { createdFiles: ['src/again.ts'] })

    const state = buildSessionDiffState(checkpointRoot, workspaceRoot, sessionId)

    expect(state.diffs).toHaveLength(1)
    expect(state.diffs[0]).toMatchObject({ filePath: 'src/again.ts', status: 'modified' })
    expect(state.messageIdByFile['src/again.ts']).toBe('msg_1')
  })

  it('reviews 跨 manifest 合并且 rejected 痕迹优先级最高', () => {
    writeWorkspaceFile('src/a.ts', 'new')
    writeBackupFile('msg_1', 'src/a.ts', 'old')
    writeBackupFile('msg_2', 'src/b.ts', 'old b')
    writeManifestAt('msg_1', 1000, {
      modifiedFiles: ['src/a.ts'],
      fileReviews: { 'src/a.ts': 'accepted' }
    })
    writeManifestAt('msg_2', 2000, {
      modifiedFiles: ['src/b.ts'],
      fileReviews: {
        'src/a.ts': 'rejected',
        'src/b.ts': 'accepted',
        'src/ghost.ts': 'rejected'
      }
    })

    const state = buildSessionDiffState(checkpointRoot, workspaceRoot, sessionId)

    expect(state.reviews).toEqual({
      'src/a.ts': 'rejected',
      'src/b.ts': 'accepted',
      // 不在可见 diff 中但被拒绝过的文件保留痕迹
      'src/ghost.ts': 'rejected'
    })
  })

  it('rolled-back manifest 不参与聚合，与消息级口径一致', () => {
    writeWorkspaceFile('src/live.ts', 'live change')
    writeBackupFile('msg_1', 'src/live.ts', 'old')
    writeBackupFile('msg_rolled', 'src/rolled.ts', 'was reverted')
    writeManifestAt('msg_1', 1000, { modifiedFiles: ['src/live.ts'] })
    writeManifestAt('msg_rolled', 2000, {
      modifiedFiles: ['src/rolled.ts'],
      status: 'rolled-back'
    })

    const state = buildSessionDiffState(checkpointRoot, workspaceRoot, sessionId)

    expect(state.diffs.map((diff) => diff.filePath)).toEqual(['src/live.ts'])
  })

  it('按 createdAt 排序决定最早消息；同毫秒用 messageId 兜底', () => {
    writeWorkspaceFile('src/sort.ts', 'final')
    writeBackupFile('msg_later', 'src/sort.ts', 'later original')
    writeBackupFile('msg_earlier', 'src/sort.ts', 'earliest original')
    writeManifestAt('msg_later', 3000, { modifiedFiles: ['src/sort.ts'] })
    writeManifestAt('msg_earlier', 1000, { modifiedFiles: ['src/sort.ts'] })

    const state = buildSessionDiffState(checkpointRoot, workspaceRoot, sessionId)

    expect(state.messageIdByFile['src/sort.ts']).toBe('msg_earlier')
  })

  it('最早备份被滚动清理时回退到下一个可用 backup 并路由到该消息', () => {
    writeWorkspaceFile('src/pruned.ts', 'current')
    // msg_1 声明过修改但 files/ 已被清理（backupPruned）
    writeManifestAt('msg_1', 1000, {
      modifiedFiles: ['src/pruned.ts'],
      backupPruned: true
    })
    writeBackupFile('msg_2', 'src/pruned.ts', 'surviving backup')
    writeManifestAt('msg_2', 2000, { modifiedFiles: ['src/pruned.ts'] })

    const state = buildSessionDiffState(checkpointRoot, workspaceRoot, sessionId)

    expect(state.diffs).toHaveLength(1)
    expect(state.messageIdByFile['src/pruned.ts']).toBe('msg_2')
  })

  it('备份全部缺失时跳过该文件（与消息级口径一致）', () => {
    writeWorkspaceFile('src/empty-backup.ts', 'current')
    writeManifestAt('msg_1', 1000, { modifiedFiles: ['src/empty-backup.ts'] })

    const state = buildSessionDiffState(checkpointRoot, workspaceRoot, sessionId)

    expect(state.diffs).toHaveLength(0)
    expect(state.messageIdByFile).toEqual({})
  })

  it('skippedFiles 跨 manifest 按路径去重合并', () => {
    writeBackupFile('msg_1', 'src/big.ts', 'x')
    writeBackupFile('msg_2', 'src/big.ts', 'y')
    writeManifestAt('msg_1', 1000, {
      modifiedFiles: ['src/big.ts'],
      skippedFiles: [{ path: 'src/big.ts', reason: 'oversized', bytes: 1024 }]
    })
    writeManifestAt('msg_2', 2000, {
      modifiedFiles: ['src/big.ts'],
      skippedFiles: [{ path: 'src/big.ts', reason: 'oversized', bytes: 2048 }]
    })

    const state = buildSessionDiffState(checkpointRoot, workspaceRoot, sessionId)

    expect(state.skippedFiles).toEqual([
      { path: 'src/big.ts', reason: 'oversized', bytes: 1024 }
    ])
  })
})
