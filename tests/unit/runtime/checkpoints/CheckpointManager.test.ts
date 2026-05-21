import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { CheckpointManager } from '../../../../src/runtime/checkpoints/CheckpointManager'
import { readManifest } from '../../../../src/runtime/checkpoints/manifest'

/** 临时测试目录 */
const TMP = join(process.cwd(), '.test-checkpoint-workspace')
const CHECKPOINT_ROOT = join(process.cwd(), '.test-checkpoints')
const SESSION_ID = 'test-session'
const MESSAGE_ID = 'msg-001'

function createManager(): CheckpointManager {
  return new CheckpointManager({
    checkpointDir: CHECKPOINT_ROOT,
    sessionId: SESSION_ID,
    workspaceRoot: TMP
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
