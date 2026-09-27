import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { DiffReviewService } from '../../../../src/runtime/checkpoints/DiffReviewService'
import { CheckpointManager } from '../../../../src/runtime/checkpoints/CheckpointManager'
import { buildMessageDiffState } from '../../../../src/runtime/checkpoints/diffState'
import {
  createDefaultReviewRestoreIo,
  type ReviewRestoreIo
} from '../../../../src/runtime/checkpoints/reviewRestore'
import {
  writeManifest,
  readManifest,
  getFilesDir,
  getManifestPath
} from '../../../../src/runtime/checkpoints/manifest'
import { digestFileBytes } from '../../../../src/runtime/checkpoints/fileDigest'
import type { CheckpointManifest } from '../../../../src/runtime/checkpoints/types'

/**
 * 拒绝恢复（reviewRestore + DiffReviewService）事务性测试。
 * 全部用真实临时目录、真实 manifest.json 与真实工作区文件；
 * 只在注入的 io 端口上模拟写入/删/manifest 异常，不 mock 文件读写本身。
 */
describe('审阅拒绝恢复事务', () => {
  let tmpDir: string
  let workspaceRoot: string
  let store: SessionStore
  let sessionId: string
  let checkpointRoot: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-reject-test-'))
    workspaceRoot = path.join(tmpDir, 'workspace')
    fs.mkdirSync(workspaceRoot, { recursive: true })
    store = new SessionStore(tmpDir)
    sessionId = store.create(workspaceRoot).id
    checkpointRoot = store.getSessionsDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeWorkspace(relPath: string, content: string | Buffer): void {
    const abs = path.join(workspaceRoot, relPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }

  function readWorkspace(relPath: string): Buffer | null {
    const abs = path.join(workspaceRoot, relPath)
    return fs.existsSync(abs) ? fs.readFileSync(abs) : null
  }

  function manifestBytes(messageId: string): Buffer | null {
    const p = getManifestPath(checkpointRoot, sessionId, messageId)
    return fs.existsSync(p) ? fs.readFileSync(p) : null
  }

  function digestOf(relPath: string): string | null {
    const bytes = readWorkspace(relPath)
    return bytes === null ? null : digestFileBytes(bytes)
  }

  /** 登记一条 checkpoint：备份内容写入 files/，manifest 记录三类清单 */
  function setupCheckpoint(
    messageId: string,
    spec: {
      modified?: Record<string, string | Buffer>
      deleted?: Record<string, string | Buffer>
      created?: string[]
    }
  ): CheckpointManifest {
    const manifest: CheckpointManifest = {
      sessionId,
      messageId,
      workspaceRoot,
      modifiedFiles: Object.keys(spec.modified ?? {}),
      createdFiles: spec.created ?? [],
      deletedFiles: Object.keys(spec.deleted ?? {}),
      status: 'active',
      createdAt: Date.now()
    }
    writeManifest(checkpointRoot, manifest)
    const filesDir = getFilesDir(checkpointRoot, sessionId, messageId)
    for (const [rel, content] of Object.entries(spec.modified ?? {})) {
      const p = path.join(filesDir, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content)
    }
    for (const [rel, content] of Object.entries(spec.deleted ?? {})) {
      const p = path.join(filesDir, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content)
    }
    return manifest
  }

  /** 基于默认真实 fs 实现包一层，用于注入指定环节异常或计数 */
  function ioWith(overrides: Partial<ReviewRestoreIo>): ReviewRestoreIo {
    return { ...createDefaultReviewRestoreIo(checkpointRoot), ...overrides }
  }

  it('b 登记为修改但缺备份：整批失败且 a、b、manifest 均不变', () => {
    writeWorkspace('a.txt', 'a-after')
    writeWorkspace('b.txt', 'b-after')
    setupCheckpoint('m1', { modified: { 'a.txt': 'a-base', 'b.txt': 'b-base' } })
    // 人为删掉 b 的备份制造缺口
    fs.unlinkSync(path.join(getFilesDir(checkpointRoot, sessionId, 'm1'), 'b.txt'))
    const before = manifestBytes('m1')

    const result = new DiffReviewService(store).rejectAllFiles(sessionId, 'm1', [
      { filePath: 'a.txt', expectedDigest: digestOf('a.txt') },
      { filePath: 'b.txt', expectedDigest: digestOf('b.txt') }
    ])

    expect(result.restored).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({ filePath: 'b.txt' })
    expect(readWorkspace('a.txt')?.toString()).toBe('a-after')
    expect(readWorkspace('b.txt')?.toString()).toBe('b-after')
    expect(manifestBytes('m1')?.equals(before!)).toBe(true)
  })

  it('b 未登记在该消息 checkpoint：整批失败零副作用', () => {
    writeWorkspace('a.txt', 'a-after')
    writeWorkspace('b.txt', 'b-user')
    setupCheckpoint('m1', { modified: { 'a.txt': 'a-base' } })
    const before = manifestBytes('m1')

    const result = new DiffReviewService(store).rejectAllFiles(sessionId, 'm1', [
      { filePath: 'a.txt', expectedDigest: digestOf('a.txt') },
      { filePath: 'b.txt', expectedDigest: digestOf('b.txt') }
    ])

    expect(result.restored).toEqual([])
    expect(result.failed[0]?.error).toContain('不在当前消息的 checkpoint 中')
    expect(readWorkspace('a.txt')?.toString()).toBe('a-after')
    expect(readWorkspace('b.txt')?.toString()).toBe('b-user')
    expect(manifestBytes('m1')?.equals(before!)).toBe(true)
  })

  it('用户查看 diff 后又改了文件：摘要冲突、零副作用、用户内容保留', () => {
    writeWorkspace('a.txt', 'user-new-edit')
    const viewedDigest = digestFileBytes(Buffer.from('a-after')) // 用户看到时的版本
    setupCheckpoint('m1', { modified: { 'a.txt': 'a-base' } })
    const before = manifestBytes('m1')

    const result = new DiffReviewService(store).rejectAllFiles(sessionId, 'm1', [
      { filePath: 'a.txt', expectedDigest: viewedDigest }
    ])

    expect(result.restored).toEqual([])
    expect(result.failed[0]?.error).toContain('又被修改过')
    expect(readWorkspace('a.txt')?.toString()).toBe('user-new-edit')
    expect(manifestBytes('m1')?.equals(before!)).toBe(true)
  })

  it('第二个文件写入异常：已恢复的 a 回到操作前，manifest 不变', () => {
    writeWorkspace('a.txt', 'a-after')
    writeWorkspace('b.txt', 'b-after')
    setupCheckpoint('m1', { modified: { 'a.txt': 'a-base', 'b.txt': 'b-base' } })
    const before = manifestBytes('m1')
    const io = ioWith({
      rename(from, to) {
        if (to.endsWith('b.txt')) throw new Error('disk full')
        fs.renameSync(from, to)
      }
    })

    const result = new DiffReviewService(store, io).rejectAllFiles(sessionId, 'm1', [
      { filePath: 'a.txt', expectedDigest: digestOf('a.txt') },
      { filePath: 'b.txt', expectedDigest: digestOf('b.txt') }
    ])

    expect(result.restored).toEqual([])
    expect(result.failed[0]?.error).toContain('已回滚')
    expect(readWorkspace('a.txt')?.toString()).toBe('a-after')
    expect(readWorkspace('b.txt')?.toString()).toBe('b-after')
    expect(manifestBytes('m1')?.equals(before!)).toBe(true)
  })

  it('manifest 写入异常：所有已动文件补偿回操作前', () => {
    writeWorkspace('a.txt', 'a-after')
    writeWorkspace('b.txt', 'b-after')
    setupCheckpoint('m1', { modified: { 'a.txt': 'a-base', 'b.txt': 'b-base' } })
    const before = manifestBytes('m1')
    const io = ioWith({
      writeManifest() {
        throw new Error('manifest write failed')
      }
    })

    const result = new DiffReviewService(store, io).rejectAllFiles(sessionId, 'm1', [
      { filePath: 'a.txt', expectedDigest: digestOf('a.txt') },
      { filePath: 'b.txt', expectedDigest: digestOf('b.txt') }
    ])

    expect(result.restored).toEqual([])
    expect(result.failed[0]?.error).toContain('已回滚')
    expect(readWorkspace('a.txt')?.toString()).toBe('a-after')
    expect(readWorkspace('b.txt')?.toString()).toBe('b-after')
    expect(manifestBytes('m1')?.equals(before!)).toBe(true)
  })

  it('补偿也失败：抛错列出未回滚路径，文案不声称已回滚', () => {
    writeWorkspace('a.txt', 'a-after')
    writeWorkspace('b.txt', 'b-after')
    setupCheckpoint('m1', { modified: { 'a.txt': 'a-base', 'b.txt': 'b-base' } })
    // a 写成功、b 写失败触发补偿、a 补偿也失败 → a 留在中间态
    let renameCalls = 0
    const io = ioWith({
      rename(from, to) {
        renameCalls++
        if (renameCalls === 1) {
          fs.renameSync(from, to)
          return
        }
        throw new Error('rename fails after first')
      }
    })

    let thrown: unknown
    try {
      new DiffReviewService(store, io).rejectAllFiles(sessionId, 'm1', [
        { filePath: 'a.txt', expectedDigest: digestOf('a.txt') },
        { filePath: 'b.txt', expectedDigest: digestOf('b.txt') }
      ])
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain('a.txt')
    expect(message).not.toContain('已回滚')
    // b 的写入被拒在工作区落盘失败，b 仍是原字节；a 补偿失败处于备份态
    expect(readWorkspace('b.txt')?.toString()).toBe('b-after')
  })

  it('成功路径：三类文件、二进制与 CRLF 原样、manifest 只写一次且无临时残留', () => {
    const bin = Buffer.from([0x00, 0x9f, 0xff, 0x10, 0x00])
    const crlf = 'line1\r\nline2\r\n'
    writeWorkspace('bin.dat', Buffer.from([0x61, 0x62]))
    writeWorkspace('crlf.txt', 'crlf-after\r\n')
    writeWorkspace('中文 名.txt', 'after')
    writeWorkspace('new.txt', 'created-by-agent')
    writeWorkspace('keep.tmp', 'user tmp file')
    setupCheckpoint('m1', {
      modified: { 'bin.dat': bin, 'crlf.txt': crlf, '中文 名.txt': 'base' },
      created: ['new.txt'],
      deleted: { 'gone.txt': 'was-deleted' }
    })
    let manifestWrites = 0
    const io = ioWith({
      writeManifest(manifest) {
        manifestWrites++
        writeManifest(checkpointRoot, manifest)
      }
    })
    const service = new DiffReviewService(store, io)

    const result = service.rejectAllFiles(sessionId, 'm1', [
      { filePath: 'bin.dat', expectedDigest: digestOf('bin.dat') },
      { filePath: 'crlf.txt', expectedDigest: digestOf('crlf.txt') },
      { filePath: '中文 名.txt', expectedDigest: digestOf('中文 名.txt') },
      { filePath: 'new.txt', expectedDigest: digestOf('new.txt') },
      { filePath: 'gone.txt', expectedDigest: digestOf('gone.txt') }
    ])

    expect(result.failed).toEqual([])
    expect(result.restored.sort()).toEqual(
      ['bin.dat', 'crlf.txt', 'gone.txt', 'new.txt', '中文 名.txt'].sort()
    )
    expect(readWorkspace('bin.dat')?.equals(bin)).toBe(true)
    expect(readWorkspace('crlf.txt')?.toString()).toBe(crlf)
    expect(readWorkspace('中文 名.txt')?.toString()).toBe('base')
    expect(readWorkspace('new.txt')).toBeNull()
    expect(readWorkspace('gone.txt')?.toString()).toBe('was-deleted')
    expect(readWorkspace('keep.tmp')?.toString()).toBe('user tmp file')
    // 不残留本操作的临时文件
    const leftovers = fs.readdirSync(workspaceRoot).filter(n => n.startsWith('.nova-restore-'))
    expect(leftovers).toEqual([])

    expect(manifestWrites).toBe(1)
    const manifest = readManifest(checkpointRoot, sessionId, 'm1')!
    expect(manifest.modifiedFiles).toEqual([])
    expect(manifest.createdFiles).toEqual([])
    expect(manifest.deletedFiles).toEqual([])
    expect(manifest.status).toBe('rolled-back')
    for (const fp of ['bin.dat', 'crlf.txt', '中文 名.txt', 'new.txt', 'gone.txt']) {
      expect(manifest.fileReviews?.[fp]).toBe('rejected')
    }
  })

  it('成功后再次拒绝同一文件报「不在 checkpoint」；请求内重复路径去重', () => {
    writeWorkspace('a.txt', 'a-after')
    setupCheckpoint('m1', { modified: { 'a.txt': 'a-base' } })
    const service = new DiffReviewService(store)

    const first = service.rejectAllFiles(sessionId, 'm1', [
      { filePath: 'a.txt', expectedDigest: digestOf('a.txt') },
      { filePath: 'a.txt', expectedDigest: digestOf('a.txt') }
    ])
    expect(first.failed).toEqual([])
    expect(first.restored).toEqual(['a.txt'])

    const second = service.rejectAllFiles(sessionId, 'm1', [
      { filePath: 'a.txt', expectedDigest: digestOf('a.txt') }
    ])
    expect(second.restored).toEqual([])
    expect(second.failed[0]?.error).toContain('不在当前消息的 checkpoint 中')
    expect(readWorkspace('a.txt')?.toString()).toBe('a-base')
  })

  // junction/symlink/短路径别名下 workspaceRoot 与工具写入路径词法不一致，
  // checkpoint 仍须记录干净的相对路径，diff 与拒绝链路保持可用
  it.skipIf(process.platform !== 'win32')('junction 别名工作区：相对路径不逃逸、可 diff、可拒绝恢复', () => {
    const realWorkspace = workspaceRoot
    const aliasRoot = path.join(tmpDir, 'ws-alias')
    fs.symlinkSync(realWorkspace, aliasRoot, 'junction')

    const aliasStore = new SessionStore(tmpDir)
    const aliasSessionId = aliasStore.create(aliasRoot).id
    const manager = new CheckpointManager({
      checkpointDir: aliasStore.getSessionsDir(),
      sessionId: aliasSessionId,
      workspaceRoot: aliasRoot
    })

    // 用户已有文件，agent 经 canonical（realpath 解析后的真实）路径写入
    writeWorkspace('sub/junction-file.txt', 'before')
    const realPath = fs.realpathSync.native(path.join(realWorkspace, 'sub/junction-file.txt'))
    manager.beginMessage('m-alias')
    manager.backupBeforeWrite(realPath, false)
    fs.writeFileSync(realPath, 'after')
    manager.endMessage()

    const manifest = readManifest(aliasStore.getSessionsDir(), aliasSessionId, 'm-alias')!
    expect(manifest.modifiedFiles).toEqual(['sub/junction-file.txt'])
    for (const fp of manifest.modifiedFiles) {
      expect(fp).not.toContain('..')
    }

    const diffState = buildMessageDiffState(
      aliasStore.getSessionsDir(), aliasRoot, aliasSessionId, 'm-alias'
    )
    expect(diffState.diffs.map(d => d.filePath)).toEqual(['sub/junction-file.txt'])

    const result = new DiffReviewService(aliasStore).rejectAllFiles(aliasSessionId, 'm-alias', [
      { filePath: 'sub/junction-file.txt', expectedDigest: diffState.diffs[0]!.currentDigest }
    ])
    expect(result.failed).toEqual([])
    expect(readWorkspace('sub/junction-file.txt')?.toString()).toBe('before')
  })
})
