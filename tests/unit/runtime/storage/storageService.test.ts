import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  getStorageUsageReport,
  pruneSessionCheckpoints,
  pruneAllCheckpoints,
  deleteSessionCompletely,
  runStartupGc
} from '../../../../src/runtime/storage/storageService'
import { writeManifest } from '../../../../src/runtime/checkpoints/manifest'

/** 创建临时目录用于测试 */
let tmpDir: string
let appDataPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-storage-test-'))
  appDataPath = tmpDir
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function createSessionDir(sessionId: string): string {
  const dir = path.join(appDataPath, 'sessions', sessionId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeSessionFile(sessionId: string, bytes: number): void {
  const dir = createSessionDir(sessionId)
  fs.writeFileSync(path.join(dir, 'session.json'), 'x'.repeat(bytes), 'utf8')
}

function writeCheckpointBackup(
  sessionId: string,
  messageId: string,
  relPath: string,
  content: string
): void {
  const dir = createSessionDir(sessionId)
  const filesDir = path.join(dir, messageId, 'files')
  fs.mkdirSync(filesDir, { recursive: true })
  const filePath = path.join(filesDir, relPath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')

  writeManifest(path.join(appDataPath, 'sessions'), {
    sessionId,
    messageId,
    workspaceRoot: '/tmp/workspace',
    createdFiles: [],
    modifiedFiles: [relPath],
    deletedFiles: [],
    status: 'active',
    createdAt: Date.now()
  })
}

function writeArtifact(sessionId: string, content: string): void {
  const dir = createSessionDir(sessionId)
  const artifactsDir = path.join(dir, 'artifacts')
  fs.mkdirSync(artifactsDir, { recursive: true })
  fs.writeFileSync(path.join(artifactsDir, 'art-001'), content, 'utf8')
}

function writeBashTempLog(content: string): string {
  const filePath = path.join(os.tmpdir(), `nova-bash-${Date.now()}.log`)
  fs.writeFileSync(filePath, content, 'utf8')
  return filePath
}

describe('getStorageUsageReport', () => {
  it('空应用数据返回 0 字节', () => {
    const report = getStorageUsageReport(appDataPath)
    expect(report.totalBytes).toBe(0)
    expect(report.sessions).toHaveLength(0)
  })

  it('按会话分类统计历史、checkpoint、artifacts', () => {
    writeSessionFile('sess_a', 100)
    writeCheckpointBackup('sess_a', 'msg_1', 'src/app.ts', 'a'.repeat(200))
    writeArtifact('sess_a', 'b'.repeat(300))

    const report = getStorageUsageReport(appDataPath)
    expect(report.sessions).toHaveLength(1)

    const sess = report.sessions[0]
    expect(sess.sessionId).toBe('sess_a')
    expect(sess.historyBytes).toBeGreaterThanOrEqual(100)
    expect(sess.checkpointsBytes).toBeGreaterThanOrEqual(200)
    expect(sess.artifactsBytes).toBeGreaterThanOrEqual(300)
    expect(sess.totalBytes).toBeGreaterThanOrEqual(600)
    expect(report.totalBytes).toBeGreaterThanOrEqual(600)
  })
})

describe('pruneSessionCheckpoints', () => {
  it('只删除 files/ 目录，保留 manifest.json 并标记 backupPruned', () => {
    writeCheckpointBackup('sess_a', 'msg_1', 'src/app.ts', 'backup content')

    const result = pruneSessionCheckpoints(appDataPath, 'sess_a')
    expect(result.freedBytes).toBeGreaterThan(0)
    expect(result.affectedSessions).toBe(1)

    const sessionDir = path.join(appDataPath, 'sessions', 'sess_a')
    expect(fs.existsSync(path.join(sessionDir, 'msg_1', 'files'))).toBe(false)
    expect(fs.existsSync(path.join(sessionDir, 'msg_1', 'manifest.json'))).toBe(true)

    const manifest = JSON.parse(fs.readFileSync(path.join(sessionDir, 'msg_1', 'manifest.json'), 'utf8'))
    expect(manifest.backupPruned).toBe(true)
    expect(manifest.prunedAt).toBeGreaterThan(0)
  })

  it('清理不存在的会话返回 0 字节', () => {
    const result = pruneSessionCheckpoints(appDataPath, 'non-existent')
    expect(result.freedBytes).toBe(0)
    expect(result.affectedSessions).toBe(0)
  })
})

describe('pruneAllCheckpoints', () => {
  it('清理所有会话的 checkpoint files', () => {
    writeCheckpointBackup('sess_a', 'msg_1', 'a.ts', 'a')
    writeCheckpointBackup('sess_b', 'msg_1', 'b.ts', 'b')

    const result = pruneAllCheckpoints(appDataPath)
    expect(result.freedBytes).toBeGreaterThan(0)
    expect(result.affectedSessions).toBe(2)

    expect(fs.existsSync(path.join(appDataPath, 'sessions', 'sess_a', 'msg_1', 'files'))).toBe(false)
    expect(fs.existsSync(path.join(appDataPath, 'sessions', 'sess_b', 'msg_1', 'files'))).toBe(false)
  })
})

describe('deleteSessionCompletely', () => {
  it('彻底删除会话目录并返回释放字节数', () => {
    writeSessionFile('sess_a', 100)
    writeCheckpointBackup('sess_a', 'msg_1', 'a.ts', 'a')

    const result = deleteSessionCompletely(appDataPath, 'sess_a')
    expect(result.freedBytes).toBeGreaterThan(100)
    expect(result.affectedSessions).toBe(1)
    expect(fs.existsSync(path.join(appDataPath, 'sessions', 'sess_a'))).toBe(false)
  })
})

describe('runStartupGc', () => {
  it('删除 nova-bash-*.log 临时文件', () => {
    const logPath = writeBashTempLog('some log content')

    const result = runStartupGc(appDataPath, 30)
    expect(result.freedBytes).toBeGreaterThan(0)
    expect(fs.existsSync(logPath)).toBe(false)
  })

  it('删除超过保留天数的陈旧 checkpoint files', () => {
    const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000
    writeCheckpointBackup('sess_a', 'msg_old', 'old.ts', 'old content')

    // 把 manifest 的 createdAt 改为陈旧时间
    const manifestPath = path.join(appDataPath, 'sessions', 'sess_a', 'msg_old', 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.createdAt = oldTime
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    const result = runStartupGc(appDataPath, 30)
    expect(result.freedBytes).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(appDataPath, 'sessions', 'sess_a', 'msg_old', 'files'))).toBe(false)
  })

  it('不删除未超期的 checkpoint files', () => {
    writeCheckpointBackup('sess_a', 'msg_recent', 'recent.ts', 'recent content')

    const result = runStartupGc(appDataPath, 30)
    expect(result.freedBytes).toBe(0)
    expect(fs.existsSync(path.join(appDataPath, 'sessions', 'sess_a', 'msg_recent', 'files'))).toBe(true)
  })
})
