import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildMessageDiffState } from '../../../../src/runtime/checkpoints/diffState'
import { writeManifest, getFilesDir } from '../../../../src/runtime/checkpoints/manifest'
import type { CheckpointManifest } from '../../../../src/runtime/checkpoints/types'
import { digestFileBytes } from '../../../../src/runtime/checkpoints/fileDigest'

let tmpDir: string
let checkpointRoot: string
let workspaceRoot: string
const sessionId = 'sess_diff_state'

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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-diff-state-'))
  checkpointRoot = path.join(tmpDir, 'checkpoints')
  workspaceRoot = path.join(tmpDir, 'workspace')
  fs.mkdirSync(checkpointRoot, { recursive: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('buildMessageDiffState', () => {
  it('删除的文件被用户重建后展示真实内容，文件仍不存在时保留删除状态', () => {
    const messageId = 'msg_recreated'
    const relPath = 'src/recreated.ts'
    writeBackupFile(messageId, relPath, 'ORIGINAL')
    writeManifest(checkpointRoot, {
      sessionId,
      messageId,
      workspaceRoot,
      createdFiles: [],
      modifiedFiles: [],
      deletedFiles: [relPath],
      status: 'active',
      createdAt: Date.now()
    })

    writeWorkspaceFile(relPath, 'USER_RECREATED')
    const recreated = buildMessageDiffState(checkpointRoot, workspaceRoot, sessionId, messageId).diffs[0]!
    expect(recreated.status).toBe('modified')
    expect(recreated.hunks.map(h => h.content).join('\n')).toContain('+USER_RECREATED')
    expect(recreated.currentDigest).toBe(digestFileBytes(Buffer.from('USER_RECREATED')))

    fs.unlinkSync(path.join(workspaceRoot, relPath))
    const deleted = buildMessageDiffState(checkpointRoot, workspaceRoot, sessionId, messageId).diffs[0]!
    expect(deleted.status).toBe('deleted')
    expect(deleted.currentDigest).toBeNull()
  })

  it('返回当前可见 diff，并保留 rejected 文件状态', () => {
    const messageId = 'msg_1'
    writeWorkspaceFile('src/visible.ts', 'new visible')
    writeBackupFile(messageId, 'src/visible.ts', 'old visible')

    const manifest: CheckpointManifest = {
      sessionId,
      messageId,
      workspaceRoot,
      createdFiles: [],
      modifiedFiles: ['src/visible.ts'],
      deletedFiles: [],
      status: 'active',
      createdAt: Date.now(),
      fileReviews: {
        'src/visible.ts': 'accepted',
        'src/rejected.ts': 'rejected'
      }
    }
    writeManifest(checkpointRoot, manifest)

    const result = buildMessageDiffState(checkpointRoot, workspaceRoot, sessionId, messageId)

    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].filePath).toBe('src/visible.ts')
    expect(result.reviews).toEqual({
      'src/visible.ts': 'accepted',
      'src/rejected.ts': 'rejected'
    })
  })
})
