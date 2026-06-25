import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { CheckpointManager } from '../../../../src/runtime/checkpoints/CheckpointManager'
import { readManifest } from '../../../../src/runtime/checkpoints/manifest'
import type { CheckpointConfig } from '../../../../src/runtime/checkpoints/types'

/** 临时测试目录 */
const TMP = join(process.cwd(), '.test-checkpoint-workspace')
const CHECKPOINT_ROOT = join(process.cwd(), '.test-checkpoints')
const SESSION_ID = 'test-session'
const MESSAGE_ID = 'msg-001'

function createManager(overrides?: Partial<CheckpointConfig>): CheckpointManager {
  return new CheckpointManager({
    checkpointDir: CHECKPOINT_ROOT,
    sessionId: SESSION_ID,
    workspaceRoot: TMP,
    ...overrides
  })
}

describe('CheckpointManager', () => {
  beforeEach(() => {
    // 创建工作区
    mkdirSync(TMP, { recursive: true })
    writeFileSync(join(TMP, 'existing.txt'), '原始内容\n')
    mkdirSync(join(TMP, 'src'), { recursive: true })
    writeFileSync(join(TMP, 'src', 'main.ts'), 'const x = 1\n')

    // 确保 checkpoint 根目录干净
    rmSync(CHECKPOINT_ROOT, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    rmSync(CHECKPOINT_ROOT, { recursive: true, force: true })
  })

  // ── beginMessage / endMessage 事务边界 ─────────────────────

  describe('事务边界', () => {
    it('beginMessage 设置消息 ID，endMessage 清除', () => {
      const mgr = createManager()
      expect(mgr.getCurrentMessageId()).toBeNull()
      mgr.beginMessage(MESSAGE_ID)
      expect(mgr.getCurrentMessageId()).toBe(MESSAGE_ID)
      mgr.endMessage()
      expect(mgr.getCurrentMessageId()).toBeNull()
    })
  })

  // ── 备份已有文件（modifiedFiles） ──────────────────────────

  describe('备份已有文件', () => {
    it('第一次修改已有文件时，原始内容被备份', () => {
      const mgr = createManager()
      mgr.beginMessage(MESSAGE_ID)

      const filePath = join(TMP, 'existing.txt')
      mgr.backupBeforeWrite(filePath, false)

      // 验证 manifest
      const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
      expect(manifest).not.toBeNull()
      expect(manifest!.modifiedFiles).toContain('existing.txt')
      expect(manifest!.createdFiles).toHaveLength(0)

      // 验证备份文件内容
      const backupPath = join(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID, 'files', 'existing.txt')
      expect(existsSync(backupPath)).toBe(true)
      expect(readFileSync(backupPath, 'utf-8')).toBe('原始内容\n')
    })

    it('子目录中的文件也能正确备份', () => {
      const mgr = createManager()
      mgr.beginMessage(MESSAGE_ID)

      const filePath = join(TMP, 'src', 'main.ts')
      mgr.backupBeforeWrite(filePath, false)

      const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
      expect(manifest!.modifiedFiles).toContain('src/main.ts')

      const backupPath = join(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID, 'files', 'src', 'main.ts')
      expect(existsSync(backupPath)).toBe(true)
    })
  })

  // ── 新建文件（createdFiles） ────────────────────────────────

  describe('新建文件', () => {
    it('标记为新建的文件不备份内容，只记录到 createdFiles', () => {
      const mgr = createManager()
      mgr.beginMessage(MESSAGE_ID)

      const filePath = join(TMP, 'new-file.ts')
      mgr.backupBeforeWrite(filePath, true)

      const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
      expect(manifest!.createdFiles).toContain('new-file.ts')
      expect(manifest!.modifiedFiles).toHaveLength(0)

      // 新建文件不应产生备份
      const backupPath = join(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID, 'files', 'new-file.ts')
      expect(existsSync(backupPath)).toBe(false)
    })

    it('文件不存在时自动识别为新建', () => {
      const mgr = createManager()
      mgr.beginMessage(MESSAGE_ID)

      const filePath = join(TMP, 'not-exist.ts')
      mgr.backupBeforeWrite(filePath, false)

      const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
      expect(manifest!.createdFiles).toContain('not-exist.ts')
    })
  })

  // ── 同一文件多次修改只备份一次 ──────────────────────────────

  describe('去重备份', () => {
    it('同一消息内多次修改同一文件只备份一次', () => {
      const mgr = createManager()
      mgr.beginMessage(MESSAGE_ID)

      const filePath = join(TMP, 'existing.txt')

      // 第一次备份
      mgr.backupBeforeWrite(filePath, false)
      // 第二次备份（不应重复）
      mgr.backupBeforeWrite(filePath, false)

      const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
      // modifiedFiles 中只出现一次
      expect(manifest!.modifiedFiles.filter(f => f === 'existing.txt')).toHaveLength(1)
    })
  })

  // ── 多文件混合场景 ──────────────────────────────────────────

  describe('多文件场景', () => {
    it('同时记录修改和新建的多个文件', () => {
      const mgr = createManager()
      mgr.beginMessage(MESSAGE_ID)

      mgr.backupBeforeWrite(join(TMP, 'existing.txt'), false)
      mgr.backupBeforeWrite(join(TMP, 'src', 'main.ts'), false)
      mgr.backupBeforeWrite(join(TMP, 'brand-new.ts'), true)

      const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
      expect(manifest!.modifiedFiles).toHaveLength(2)
      expect(manifest!.createdFiles).toHaveLength(1)
      expect(manifest!.status).toBe('active')
    })
  })

  describe('recordBashChange', () => {
    it('bash 修改文件时会把原始内容写入 modifiedFiles 备份', () => {
      const mgr = createManager()
      mgr.beginMessage(MESSAGE_ID)

      const filePath = join(TMP, 'existing.txt')
      mgr.recordBashChange(filePath, 'bash 前内容\n', false)

      const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
      expect(manifest!.modifiedFiles).toContain('existing.txt')

      const backupPath = join(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID, 'files', 'existing.txt')
      expect(readFileSync(backupPath, 'utf-8')).toBe('bash 前内容\n')
    })

    it('bash 删除文件时会写入 deletedFiles 并保留恢复备份', () => {
      const mgr = createManager()
      mgr.beginMessage(MESSAGE_ID)

      const filePath = join(TMP, 'src', 'main.ts')
      mgr.recordBashChange(filePath, 'const x = 1\n', false, true)

      const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
      expect(manifest!.deletedFiles).toContain('src/main.ts')

      const backupPath = join(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID, 'files', 'src', 'main.ts')
      expect(readFileSync(backupPath, 'utf-8')).toBe('const x = 1\n')
    })
  })

  // ── 跨消息隔离 ──────────────────────────────────────────────

  describe('跨消息隔离', () => {
    it('不同消息有不同的备份集合', () => {
      const mgr = createManager()

      // 第一条消息
      mgr.beginMessage('msg-001')
      mgr.backupBeforeWrite(join(TMP, 'existing.txt'), false)
      mgr.endMessage()

      // 第二条消息
      mgr.beginMessage('msg-002')
      mgr.backupBeforeWrite(join(TMP, 'src', 'main.ts'), false)
      mgr.endMessage()

      const m1 = readManifest(CHECKPOINT_ROOT, SESSION_ID, 'msg-001')
      const m2 = readManifest(CHECKPOINT_ROOT, SESSION_ID, 'msg-002')

      expect(m1!.modifiedFiles).toContain('existing.txt')
      expect(m2!.modifiedFiles).toContain('src/main.ts')
    })
  })

  // ── 大小限制 ────────────────────────────────────────────────

  describe('大小限制', () => {
    it('超过 maxBackupFileBytes 的文件只记录 skippedFiles，不生成物理备份', () => {
      const mgr = createManager({ maxBackupFileBytes: 10 })
      mgr.beginMessage(MESSAGE_ID)

      const filePath = join(TMP, 'big.txt')
      writeFileSync(filePath, 'x'.repeat(20), 'utf8')
      mgr.backupBeforeWrite(filePath, false)

      const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
      expect(manifest!.modifiedFiles).toHaveLength(0)
      expect(manifest!.skippedFiles).toHaveLength(1)
      expect(manifest!.skippedFiles![0]).toMatchObject({
        path: 'big.txt',
        reason: 'oversized'
      })
      expect(manifest!.skippedFiles![0].bytes).toBeGreaterThan(10)

      const backupPath = join(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID, 'files', 'big.txt')
      expect(existsSync(backupPath)).toBe(false)
    })

    it('未超过上限的文件正常备份', () => {
      const mgr = createManager({ maxBackupFileBytes: 1024 })
      mgr.beginMessage(MESSAGE_ID)

      const filePath = join(TMP, 'small.txt')
      writeFileSync(filePath, 'small content', 'utf8')
      mgr.backupBeforeWrite(filePath, false)

      const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
      expect(manifest!.modifiedFiles).toContain('small.txt')
      expect(manifest!.skippedFiles ?? []).toHaveLength(0)
    })
  })

  // ── 排除规则 ────────────────────────────────────────────────

  describe('排除规则', () => {
    it('node_modules 目录命中排除，只记录 skippedFiles', () => {
      const mgr = createManager()
      mgr.beginMessage(MESSAGE_ID)

      mkdirSync(join(TMP, 'node_modules', 'foo'), { recursive: true })
      const filePath = join(TMP, 'node_modules', 'foo', 'index.js')
      writeFileSync(filePath, 'module code', 'utf8')
      mgr.backupBeforeWrite(filePath, false)

      const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
      expect(manifest!.modifiedFiles).toHaveLength(0)
      expect(manifest!.skippedFiles).toHaveLength(1)
      expect(manifest!.skippedFiles![0]).toMatchObject({
        path: 'node_modules/foo/index.js',
        reason: 'excluded'
      })

      const backupPath = join(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID, 'files', 'node_modules', 'foo', 'index.js')
      expect(existsSync(backupPath)).toBe(false)
    })

    it('.env 文件命中排除，只记录 skippedFiles', () => {
      const mgr = createManager()
      mgr.beginMessage(MESSAGE_ID)

      const filePath = join(TMP, '.env')
      writeFileSync(filePath, 'SECRET=123', 'utf8')
      mgr.backupBeforeWrite(filePath, false)

      const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
      expect(manifest!.modifiedFiles).toHaveLength(0)
      expect(manifest!.skippedFiles).toHaveLength(1)
      expect(manifest!.skippedFiles![0].reason).toBe('excluded')
    })

    it('二进制扩展名命中排除', () => {
      const mgr = createManager()
      mgr.beginMessage(MESSAGE_ID)

      const filePath = join(TMP, 'logo.png')
      writeFileSync(filePath, 'fake image bytes', 'utf8')
      mgr.backupBeforeWrite(filePath, false)

      const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID)
      expect(manifest!.modifiedFiles).toHaveLength(0)
      expect(manifest!.skippedFiles).toHaveLength(1)
      expect(manifest!.skippedFiles![0].reason).toBe('excluded')
    })
  })

  // ── 滚动清理 ────────────────────────────────────────────────

  describe('滚动清理', () => {
    it('保留最近 N 条消息的 files/，更早的 manifest 被打 backupPruned 标记', () => {
      const mgr = createManager({ keepRecentCheckpointMessages: 2 })

      // 消息 1：修改 a.ts
      mgr.beginMessage('msg-001')
      mgr.backupBeforeWrite(join(TMP, 'existing.txt'), false)
      mgr.endMessage()

      // 消息 2：修改 src/main.ts
      mgr.beginMessage('msg-002')
      mgr.backupBeforeWrite(join(TMP, 'src', 'main.ts'), false)
      mgr.endMessage()

      // 消息 3：触发清理，应保留消息 2、3，清理消息 1
      mgr.beginMessage('msg-003')
      mgr.backupBeforeWrite(join(TMP, 'existing.txt'), false)
      mgr.endMessage()

      const oldFilesDir = join(CHECKPOINT_ROOT, SESSION_ID, 'msg-001', 'files')
      const oldManifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, 'msg-001')
      expect(existsSync(oldFilesDir)).toBe(false)
      expect(oldManifest!.backupPruned).toBe(true)
      expect(oldManifest!.prunedAt).toBeGreaterThan(0)

      // 最近的两条消息仍保留 files/
      expect(existsSync(join(CHECKPOINT_ROOT, SESSION_ID, 'msg-002', 'files'))).toBe(true)
      expect(existsSync(join(CHECKPOINT_ROOT, SESSION_ID, 'msg-003', 'files'))).toBe(true)
    })

    it('消息数未超过保留上限时不清理', () => {
      const mgr = createManager({ keepRecentCheckpointMessages: 10 })

      mgr.beginMessage('msg-001')
      mgr.backupBeforeWrite(join(TMP, 'existing.txt'), false)
      mgr.endMessage()

      const filesDir = join(CHECKPOINT_ROOT, SESSION_ID, 'msg-001', 'files')
      const manifest = readManifest(CHECKPOINT_ROOT, SESSION_ID, 'msg-001')
      expect(existsSync(filesDir)).toBe(true)
      expect(manifest!.backupPruned).toBeUndefined()
    })
  })

  // ── 异常场景 ────────────────────────────────────────────────

  describe('异常场景', () => {
    it('未调用 beginMessage 时调用 backupBeforeWrite 抛错', () => {
      const mgr = createManager()
      expect(() => {
        mgr.backupBeforeWrite(join(TMP, 'file.txt'), false)
      }).toThrow('必须先调用 beginMessage()')
    })
  })
})
