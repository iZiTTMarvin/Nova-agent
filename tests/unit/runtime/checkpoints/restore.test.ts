import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { rejectFile, revertToMessage, listManifests } from '../../../../src/runtime/checkpoints/restore'
import { writeManifest, getCheckpointDir, getFilesDir } from '../../../../src/runtime/checkpoints/manifest'
import type { CheckpointManifest } from '../../../../src/runtime/checkpoints/types'

/** 创建临时目录用于测试 */
let tmpDir: string
let checkpointRoot: string
let workspaceRoot: string
const sessionId = 'sess_test_001'

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-restore-test-'))
  checkpointRoot = path.join(tmpDir, 'checkpoints')
  workspaceRoot = path.join(tmpDir, 'workspace')
  fs.mkdirSync(checkpointRoot, { recursive: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** 创建一个测试 manifest 并写入磁盘 */
function createManifest(
  messageId: string,
  opts: {
    modifiedFiles?: string[]
    createdFiles?: string[]
    deletedFiles?: string[]
    createdAt?: number
  }
): CheckpointManifest {
  const manifest: CheckpointManifest = {
    sessionId,
    messageId,
    workspaceRoot: workspaceRoot,
    modifiedFiles: opts.modifiedFiles ?? [],
    createdFiles: opts.createdFiles ?? [],
    deletedFiles: opts.deletedFiles ?? [],
    status: 'active',
    createdAt: opts.createdAt ?? Date.now()
  }
  writeManifest(checkpointRoot, manifest)
  return manifest
}

/** 在 workspace 中创建文件 */
function writeWorkspaceFile(relPath: string, content: string): void {
  const absPath = path.join(workspaceRoot, relPath)
  const dir = path.dirname(absPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(absPath, content, 'utf8')
}

/** 在 checkpoint 备份中创建文件 */
function writeBackupFile(messageId: string, relPath: string, content: string): void {
  const filesDir = getFilesDir(checkpointRoot, sessionId, messageId)
  const backupPath = path.join(filesDir, relPath)
  const dir = path.dirname(backupPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(backupPath, content, 'utf8')
}

/** 读取 workspace 中的文件 */
function readWorkspaceFile(relPath: string): string | null {
  const absPath = path.join(workspaceRoot, relPath)
  try {
    return fs.readFileSync(absPath, 'utf8')
  } catch {
    return null
  }
}

// ── rejectFile ──────────────────────────────────────────────

describe('rejectFile', () => {
  it('拒绝修改过的文件：从备份恢复原始内容', () => {
    writeWorkspaceFile('src/app.ts', 'modified content')
    writeBackupFile('msg_1', 'src/app.ts', 'original content')

    const manifest = createManifest('msg_1', {
      modifiedFiles: ['src/app.ts']
    })

    const result = rejectFile(
      checkpointRoot, workspaceRoot, sessionId, 'msg_1', 'src/app.ts'
    )

    expect(result).toBe(true)
    expect(readWorkspaceFile('src/app.ts')).toBe('original content')

    // manifest 应更新，modifiedFiles 应变空
    const updated = writeManifest // 重新读取验证
    const checkpointDir = getCheckpointDir(checkpointRoot, sessionId, 'msg_1')
    const manifestPath = path.join(checkpointDir, 'manifest.json')
    const updatedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    expect(updatedManifest.modifiedFiles).not.toContain('src/app.ts')
  })

  it('拒绝新建的文件：从工作区删除', () => {
    writeWorkspaceFile('src/new.ts', 'new file content')

    createManifest('msg_1', {
      createdFiles: ['src/new.ts']
    })

    const result = rejectFile(
      checkpointRoot, workspaceRoot, sessionId, 'msg_1', 'src/new.ts'
    )

    expect(result).toBe(true)
    expect(readWorkspaceFile('src/new.ts')).toBeNull()
  })

  it('拒绝 manifest 中不存在的文件返回 false', () => {
    createManifest('msg_1', {
      modifiedFiles: ['src/other.ts']
    })

    writeWorkspaceFile('src/untracked.ts', 'content')

    const result = rejectFile(
      checkpointRoot, workspaceRoot, sessionId, 'msg_1', 'src/untracked.ts'
    )

    expect(result).toBe(false)
  })

  it('拒绝删除的文件：从备份恢复原始内容', () => {
    writeBackupFile('msg_1', 'src/deleted.ts', 'original deleted content')
    createManifest('msg_1', {
      deletedFiles: ['src/deleted.ts']
    })

    const result = rejectFile(
      checkpointRoot, workspaceRoot, sessionId, 'msg_1', 'src/deleted.ts'
    )

    expect(result).toBe(true)
    expect(readWorkspaceFile('src/deleted.ts')).toBe('original deleted content')
  })

  it('manifest 不存在时返回 false', () => {
    const result = rejectFile(
      checkpointRoot, workspaceRoot, sessionId, 'non_existent_msg', 'src/app.ts'
    )
    expect(result).toBe(false)
  })

  it('所有文件都拒绝后 manifest 状态变为 rolled-back', () => {
    writeBackupFile('msg_1', 'src/app.ts', 'original')
    writeWorkspaceFile('src/app.ts', 'modified')

    createManifest('msg_1', {
      modifiedFiles: ['src/app.ts']
    })

    rejectFile(checkpointRoot, workspaceRoot, sessionId, 'msg_1', 'src/app.ts')

    const checkpointDir = getCheckpointDir(checkpointRoot, sessionId, 'msg_1')
    const manifestPath = path.join(checkpointDir, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    expect(manifest.status).toBe('rolled-back')
  })
})

// ── revertToMessage ─────────────────────────────────────────

describe('revertToMessage', () => {
  it('回退单条消息：恢复修改的文件并删除新建的文件', () => {
    // 消息 1 修改了 a.ts，创建了 b.ts
    writeWorkspaceFile('src/a.ts', 'modified a')
    writeBackupFile('msg_1', 'src/a.ts', 'original a')
    writeWorkspaceFile('src/b.ts', 'new b')

    createManifest('msg_1', {
      modifiedFiles: ['src/a.ts'],
      createdFiles: ['src/b.ts'],
      createdAt: 1000
    })

    const allManifests = listManifests(checkpointRoot, sessionId)

    const result = revertToMessage(
      checkpointRoot, workspaceRoot, sessionId, 'msg_1', allManifests
    )

    expect(result).toBe(true)
    expect(readWorkspaceFile('src/a.ts')).toBe('original a')
    expect(readWorkspaceFile('src/b.ts')).toBeNull()

    // checkpoint 目录应被删除
    const checkpointDir = getCheckpointDir(checkpointRoot, sessionId, 'msg_1')
    expect(fs.existsSync(checkpointDir)).toBe(false)
  })

  it('回退多条消息：按时间顺序恢复', () => {
    // 消息 1 修改 a.ts
    writeWorkspaceFile('src/a.ts', 'a modified twice')
    writeBackupFile('msg_1', 'src/a.ts', 'original a')
    createManifest('msg_1', {
      modifiedFiles: ['src/a.ts'],
      createdAt: 1000
    })

    // 消息 2 创建 b.ts
    writeWorkspaceFile('src/b.ts', 'new b')
    createManifest('msg_2', {
      createdFiles: ['src/b.ts'],
      createdAt: 2000
    })

    const allManifests = listManifests(checkpointRoot, sessionId)

    // 从消息 1 开始回退
    const result = revertToMessage(
      checkpointRoot, workspaceRoot, sessionId, 'msg_1', allManifests
    )

    expect(result).toBe(true)
    expect(readWorkspaceFile('src/a.ts')).toBe('original a')
    expect(readWorkspaceFile('src/b.ts')).toBeNull()
  })

  it('回退不存在的消息返回 false', () => {
    const allManifests: CheckpointManifest[] = []

    const result = revertToMessage(
      checkpointRoot, workspaceRoot, sessionId, 'nonexistent', allManifests
    )

    expect(result).toBe(false)
  })

  it('回退跳过已 rolled-back 的 manifest', () => {
    writeBackupFile('msg_1', 'src/a.ts', 'original a')
    writeWorkspaceFile('src/a.ts', 'modified')

    const manifest = createManifest('msg_1', {
      modifiedFiles: ['src/a.ts'],
      createdAt: 1000
    })
    // 标记为已回退
    manifest.status = 'rolled-back'
    writeManifest(checkpointRoot, manifest)

    // 添加一个 active 的 manifest 作为回退目标
    writeWorkspaceFile('src/c.ts', 'new file c')
    createManifest('msg_2', {
      createdFiles: ['src/c.ts'],
      createdAt: 2000
    })

    // 从 msg_2 回退，msg_1 是 rolled-back 应被跳过
    const allManifests = listManifests(checkpointRoot, sessionId)
    const result = revertToMessage(
      checkpointRoot, workspaceRoot, sessionId, 'msg_2', allManifests
    )

    expect(result).toBe(true)
    expect(readWorkspaceFile('src/c.ts')).toBeNull()
  })
})

// ── listManifests ─────────────────────────────────────────

describe('listManifests', () => {
  it('空目录返回空列表', () => {
    const result = listManifests(checkpointRoot, sessionId)
    expect(result).toHaveLength(0)
  })

  it('返回按 createdAt 升序排列的 manifest 列表', () => {
    createManifest('msg_1', { createdAt: 3000 })
    createManifest('msg_2', { createdAt: 1000 })
    createManifest('msg_3', { createdAt: 2000 })

    const result = listManifests(checkpointRoot, sessionId)
    expect(result).toHaveLength(3)
    expect(result[0].messageId).toBe('msg_2')
    expect(result[1].messageId).toBe('msg_3')
    expect(result[2].messageId).toBe('msg_1')
  })

  it('会话目录不存在时返回空列表', () => {
    const result = listManifests(checkpointRoot, 'nonexistent_session')
    expect(result).toHaveLength(0)
  })
})
