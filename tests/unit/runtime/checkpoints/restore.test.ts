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

  it('预检失败时不应修改任何工作区文件或 checkpoint（原子性）', () => {
    // 消息 1：正常修改 a.ts，备份存在
    writeWorkspaceFile('src/a.ts', 'modified a')
    writeBackupFile('msg_1', 'src/a.ts', 'original a')
    createManifest('msg_1', {
      modifiedFiles: ['src/a.ts'],
      createdAt: 1000
    })

    // 消息 2：修改 b.ts，但备份缺失
    writeWorkspaceFile('src/b.ts', 'modified b')
    // 故意不创建 msg_2 的备份
    createManifest('msg_2', {
      modifiedFiles: ['src/b.ts'],
      createdAt: 2000
    })

    const allManifests = listManifests(checkpointRoot, sessionId)

    // 从 msg_1 回退会同时处理 msg_2，预检应发现 msg_2 的 b.ts 备份缺失并抛错
    expect(() =>
      revertToMessage(checkpointRoot, workspaceRoot, sessionId, 'msg_1', allManifests)
    ).toThrow('预检失败')

    // 工作区文件应未被改动
    expect(readWorkspaceFile('src/a.ts')).toBe('modified a')
    expect(readWorkspaceFile('src/b.ts')).toBe('modified b')

    // 两个 checkpoint 目录都应保留（未执行删除）
    expect(fs.existsSync(getCheckpointDir(checkpointRoot, sessionId, 'msg_1'))).toBe(true)
    expect(fs.existsSync(getCheckpointDir(checkpointRoot, sessionId, 'msg_2'))).toBe(true)
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

// ── C2 回归：二进制文件字节级回退（不再因 utf8 编码损坏） ──

describe('缺失备份硬校验', () => {
  it('rejectFile 恢复 modifiedFiles 时备份缺失会抛 Error', () => {
    writeWorkspaceFile('src/app.ts', 'modified content')
    // 故意不创建备份
    createManifest('msg_missing', { modifiedFiles: ['src/app.ts'] })

    expect(() =>
      rejectFile(checkpointRoot, workspaceRoot, sessionId, 'msg_missing', 'src/app.ts')
    ).toThrow('备份文件不存在')
  })

  it('rejectFile 恢复 deletedFiles 时备份缺失会抛 Error', () => {
    createManifest('msg_missing', { deletedFiles: ['src/app.ts'] })

    expect(() =>
      rejectFile(checkpointRoot, workspaceRoot, sessionId, 'msg_missing', 'src/app.ts')
    ).toThrow('备份文件不存在')
  })

  it('backupPruned 的 manifest 触发 rejectFile 时给出滚动清理提示', () => {
    writeWorkspaceFile('src/app.ts', 'modified content')
    const manifest = createManifest('msg_pruned', { modifiedFiles: ['src/app.ts'] })
    manifest.backupPruned = true
    manifest.prunedAt = Date.now()
    writeManifest(checkpointRoot, manifest)

    expect(() =>
      rejectFile(checkpointRoot, workspaceRoot, sessionId, 'msg_pruned', 'src/app.ts')
    ).toThrow('已被滚动清理')
  })

  it('revertToMessage 遇到缺失备份时抛 Error', () => {
    writeWorkspaceFile('src/a.ts', 'modified a')
    createManifest('msg_missing', { modifiedFiles: ['src/a.ts'], createdAt: 1000 })

    expect(() =>
      revertToMessage(
        checkpointRoot, workspaceRoot, sessionId, 'msg_missing',
        listManifests(checkpointRoot, sessionId)
      )
    ).toThrow('备份文件不存在')
  })

  it('backupPruned 的 manifest 触发 revertToMessage 时给出滚动清理提示', () => {
    writeWorkspaceFile('src/a.ts', 'modified a')
    const manifest = createManifest('msg_pruned', { modifiedFiles: ['src/a.ts'], createdAt: 1000 })
    manifest.backupPruned = true
    manifest.prunedAt = Date.now()
    writeManifest(checkpointRoot, manifest)

    expect(() =>
      revertToMessage(
        checkpointRoot, workspaceRoot, sessionId, 'msg_pruned',
        listManifests(checkpointRoot, sessionId)
      )
    ).toThrow('已被滚动清理')
  })
})

describe('C2: 二进制文件回退字节级一致', () => {
  /** 构造一个最小有效 PNG（1×1 红色像素），含非 utf8 字节序列 */
  function makePngBuffer(): Buffer {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A —— 第一字节 0x89 在 utf8 中是多字节起始
    // 若以 utf8 读 + 写会被强行解码为 U+FFFD（替换字符），导致字节序列损坏。
    // 这里直接用真实 PNG 头部 + 最小 IHDR + IDAT + IEND 的近似结构。
    return Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // signature
      0x00, 0x00, 0x00, 0x0D,                           // IHDR length
      0x49, 0x48, 0x44, 0x52,                           // "IHDR"
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,  // 1×1
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
      0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54,  // IDAT
      0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00,
      0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, 0x33,
      0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,  // IEND
      0xAE, 0x42, 0x60, 0x82
    ])
  }

  it('rejectFile 回退二进制文件后字节级一致', () => {
    const original = makePngBuffer()
    const modified = Buffer.from('modified text content', 'utf8')

    // workspace 中放修改后的"损坏"版本
    fs.writeFileSync(path.join(workspaceRoot, 'img.png'), modified)
    // 备份中放原始二进制
    const filesDir = getFilesDir(checkpointRoot, sessionId, 'msg_bin')
    fs.mkdirSync(filesDir, { recursive: true })
    fs.writeFileSync(path.join(filesDir, 'img.png'), original)

    createManifest('msg_bin', { modifiedFiles: ['img.png'] })

    const result = rejectFile(
      checkpointRoot, workspaceRoot, sessionId, 'msg_bin', 'img.png'
    )

    expect(result).toBe(true)
    const restored = fs.readFileSync(path.join(workspaceRoot, 'img.png'))
    // C2 修复前：restore.ts 用 utf8 读写，0x89 等字节会被替换 → 字节级不等。
    // C2 修复后：直接 readFileSync/writeFileSync 不带编码 → 字节级一致。
    expect(restored.equals(original)).toBe(true)
  })

  it('revertToMessage 回退多个二进制文件后字节级一致', () => {
    const png1 = makePngBuffer()
    const png2 = Buffer.from([0x00, 0xFF, 0x80, 0x7F, 0xC0, 0xAF, 0xFE, 0xDC])

    // workspace 放"损坏"文本
    fs.writeFileSync(path.join(workspaceRoot, 'a.png'), 'corrupted')
    fs.writeFileSync(path.join(workspaceRoot, 'b.bin'), 'corrupted')

    // 备份放原始二进制
    const filesDir = getFilesDir(checkpointRoot, sessionId, 'msg_bin2')
    fs.mkdirSync(filesDir, { recursive: true })
    fs.writeFileSync(path.join(filesDir, 'a.png'), png1)
    fs.writeFileSync(path.join(filesDir, 'b.bin'), png2)

    createManifest('msg_bin2', { modifiedFiles: ['a.png', 'b.bin'] })

    const ok = revertToMessage(
      checkpointRoot, workspaceRoot, sessionId, 'msg_bin2',
      listManifests(checkpointRoot, sessionId)
    )
    expect(ok).toBe(true)

    const restoredA = fs.readFileSync(path.join(workspaceRoot, 'a.png'))
    const restoredB = fs.readFileSync(path.join(workspaceRoot, 'b.bin'))
    expect(restoredA.equals(png1)).toBe(true)
    expect(restoredB.equals(png2)).toBe(true)
  })
})
