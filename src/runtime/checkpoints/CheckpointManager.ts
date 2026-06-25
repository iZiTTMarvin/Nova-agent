/**
 * CheckpointManager — 写前备份与 manifest 管理
 *
 * 核心职责：
 * 1. 在每次修改文件前，如果该文件尚未备份过，就将原始内容保存到 checkpoint 目录
 * 2. 维护 manifest.json，记录本轮新建 / 修改 / 删除的文件
 * 3. 同一消息内多次修改同一文件只备份一次
 * 4. 支持按消息开始/结束来管理事务边界
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'fs'
import { join, relative, dirname } from 'path'
import type { CheckpointConfig, CheckpointManifest, SkippedFileInfo } from './types'
import { writeManifest, readManifest, getFilesDir } from './manifest'
import { isExcludedPath } from './exclusions'
import { pruneOldCheckpoints } from './prune'

/** 默认单个文件备份上限：5MB */
const DEFAULT_MAX_BACKUP_FILE_BYTES = 5 * 1024 * 1024

/** 默认保留最近 checkpoint 消息数 */
const DEFAULT_KEEP_RECENT_CHECKPOINT_MESSAGES = 30

export class CheckpointManager {
  private config: CheckpointConfig
  /** 当前消息 ID（事务边界） */
  private currentMessageId: string | null = null
  /** 当前消息内已备份的文件集合（相对路径），防止同一文件重复备份 */
  private backedUpFiles: Set<string> = new Set()

  constructor(config: CheckpointConfig) {
    this.config = {
      maxBackupFileBytes: DEFAULT_MAX_BACKUP_FILE_BYTES,
      keepRecentCheckpointMessages: DEFAULT_KEEP_RECENT_CHECKPOINT_MESSAGES,
      ...config
    }
  }

  /** 获取生效的单个文件大小上限（字节） */
  private getMaxBackupFileBytes(): number {
    return this.config.maxBackupFileBytes ?? DEFAULT_MAX_BACKUP_FILE_BYTES
  }

  /** 获取生效的滚动保留消息数 */
  private getKeepRecentCheckpointMessages(): number {
    return this.config.keepRecentCheckpointMessages ?? DEFAULT_KEEP_RECENT_CHECKPOINT_MESSAGES
  }

  /** 获取 checkpoint 根目录 */
  getCheckpointDir(): string {
    return this.config.checkpointDir
  }

  /** 获取会话 ID */
  getSessionId(): string {
    return this.config.sessionId
  }

  /** 开始一条新消息的事务边界 */
  beginMessage(messageId: string): void {
    this.currentMessageId = messageId
    this.backedUpFiles.clear()

    // 每条新消息开始时，按保留策略滚动清理旧的物理备份。
    // 当前消息已占一条保留名额，因此旧消息保留 keepRecent - 1 条。
    // 只删除 files/ 目录，保留 manifest.json 作为历史记录。
    const keepRecent = this.getKeepRecentCheckpointMessages()
    if (keepRecent > 1) {
      pruneOldCheckpoints(
        this.config.checkpointDir,
        this.config.sessionId,
        keepRecent - 1
      )
    }
  }

  /** 获取当前消息 ID */
  getCurrentMessageId(): string | null {
    return this.currentMessageId
  }

  /**
   * 在文件被修改前调用，负责备份原始内容
   *
   * - 如果是新建文件（文件不存在），记录到 createdFiles
   * - 如果是已有文件且未备份过，备份原始内容并记录到 modifiedFiles
   * - 同一消息内多次调用，同一文件只备份一次
   *
   * @param absoluteFilePath 文件的绝对路径
   * @param isNewFile 调用方是否知道这是新建文件
   */
  backupBeforeWrite(absoluteFilePath: string, isNewFile: boolean): void {
    if (!this.currentMessageId) {
      throw new Error('必须先调用 beginMessage() 设置消息事务边界')
    }

    const relPath = relative(this.config.workspaceRoot, absoluteFilePath).replace(/\\/g, '/')
    const manifest = this.getOrCreateManifest()

    // 同一消息内，同一文件只备份一次
    if (this.backedUpFiles.has(relPath)) return
    this.backedUpFiles.add(relPath)

    const fileExists = existsSync(absoluteFilePath)

    if (isNewFile || !fileExists) {
      // 新建文件：无需备份原始内容，只记录到 createdFiles
      if (!manifest.createdFiles.includes(relPath)) {
        manifest.createdFiles.push(relPath)
      }
    } else {
      // 已有文件：先经过排除规则与大小限制，再决定是否物理备份
      const skipInfo = this.checkShouldSkipBackup(absoluteFilePath, relPath)
      if (skipInfo) {
        this.addSkippedFile(manifest, skipInfo)
      } else {
        // 备份原始内容，记录到 modifiedFiles
        const filesDir = getFilesDir(
          this.config.checkpointDir,
          this.config.sessionId,
          this.currentMessageId
        )
        mkdirSync(filesDir, { recursive: true })

        // 用相对路径的目录结构保存备份，避免文件名冲突
        const backupPath = join(filesDir, relPath)
        mkdirSync(join(backupPath, '..'), { recursive: true })
        copyFileSync(absoluteFilePath, backupPath)

        if (!manifest.modifiedFiles.includes(relPath)) {
          manifest.modifiedFiles.push(relPath)
        }
      }
    }

    writeManifest(this.config.checkpointDir, manifest)
  }

  /**
   * 判断已有文件是否应跳过备份。
   *
   * 返回 SkippedFileInfo 表示需要跳过（命中排除规则或超过大小上限），
   * 返回 null 表示可以正常备份。
   */
  private checkShouldSkipBackup(
    absoluteFilePath: string,
    relPath: string
  ): SkippedFileInfo | null {
    // 1. 排除规则：node_modules / dist / build / .git / .env / 二进制媒体 / 日志等
    if (isExcludedPath(relPath)) {
      return { path: relPath, reason: 'excluded', bytes: 0 }
    }

    // 2. 大小上限：超过阈值时只记录、不物理备份
    try {
      const stats = statSync(absoluteFilePath)
      const maxBytes = this.getMaxBackupFileBytes()
      if (stats.isFile() && stats.size > maxBytes) {
        return { path: relPath, reason: 'oversized', bytes: stats.size }
      }
    } catch {
      // stat 失败时不应阻塞正常备份流程，交由 copyFileSync 自行报错
    }

    return null
  }

  /** 将跳过信息写入 manifest，避免重复记录 */
  private addSkippedFile(
    manifest: CheckpointManifest,
    skipInfo: SkippedFileInfo
  ): void {
    if (!manifest.skippedFiles) {
      manifest.skippedFiles = []
    }
    const existing = manifest.skippedFiles.find(s => s.path === skipInfo.path)
    if (!existing) {
      manifest.skippedFiles.push(skipInfo)
    }
  }

  /** 获取当前 manifest，不存在则创建初始版本 */
  private getOrCreateManifest(): CheckpointManifest {
    if (!this.currentMessageId) {
      throw new Error('必须先调用 beginMessage() 设置消息事务边界')
    }

    const existing = readManifest(
      this.config.checkpointDir,
      this.config.sessionId,
      this.currentMessageId
    )
    if (existing) return existing

    return {
      sessionId: this.config.sessionId,
      messageId: this.currentMessageId,
      workspaceRoot: this.config.workspaceRoot,
      createdFiles: [],
      modifiedFiles: [],
      deletedFiles: [],
      status: 'active',
      createdAt: Date.now()
    }
  }

  /** 读取某个消息的 manifest */
  getManifest(messageId: string): CheckpointManifest | null {
    return readManifest(
      this.config.checkpointDir,
      this.config.sessionId,
      messageId
    )
  }

  /** 读取备份文件内容 */
  readBackup(relFilePath: string): string | null {
    if (!this.currentMessageId) return null

    const filesDir = getFilesDir(
      this.config.checkpointDir,
      this.config.sessionId,
      this.currentMessageId
    )
    const backupPath = join(filesDir, relFilePath)

    try {
      return readFileSync(backupPath, 'utf-8')
    } catch {
      return null
    }
  }

  /** 结束当前消息事务，更新 manifest 状态 */
  endMessage(): void {
    this.currentMessageId = null
    this.backedUpFiles.clear()
  }

  /**
   * 记录 bash 命令造成的文件变更
   *
   * 与 backupBeforeWrite 不同的是：此方法接收原始内容参数，
   * 因为 bash 已经修改了工作区文件，无法再从磁盘读取原始内容。
   *
   * @param absoluteFilePath 文件绝对路径
   * @param originalContent bash 执行前的文件内容（Buffer 二进制安全，或 string）
   * @param isNewFile bash 是否新建了该文件
   * @param isDeleted bash 是否删除了该文件
   */
  recordBashChange(
    absoluteFilePath: string,
    originalContent: Buffer | string,
    isNewFile: boolean,
    isDeleted: boolean = false
  ): void {
    if (!this.currentMessageId) return

    const relPath = relative(this.config.workspaceRoot, absoluteFilePath).replace(/\\/g, '/')

    // 如果 write/edit 已经处理过该文件，跳过
    if (this.backedUpFiles.has(relPath)) return
    this.backedUpFiles.add(relPath)

    const manifest = this.getOrCreateManifest()

    if (isDeleted) {
      // 被删除的文件：需要备份原始内容才能恢复
      const skipInfo = this.checkContentShouldSkipBackup(relPath, originalContent)
      if (skipInfo) {
        this.addSkippedFile(manifest, skipInfo)
      } else {
        this.writeBackupContent(relPath, originalContent)
        if (!manifest.deletedFiles.includes(relPath)) {
          manifest.deletedFiles.push(relPath)
        }
      }
    } else if (isNewFile) {
      if (!manifest.createdFiles.includes(relPath)) {
        manifest.createdFiles.push(relPath)
      }
    } else {
      // 修改的文件：先经过排除规则与大小限制，再决定是否物理备份
      const skipInfo = this.checkContentShouldSkipBackup(relPath, originalContent)
      if (skipInfo) {
        this.addSkippedFile(manifest, skipInfo)
      } else {
        this.writeBackupContent(relPath, originalContent)
        if (!manifest.modifiedFiles.includes(relPath)) {
          manifest.modifiedFiles.push(relPath)
        }
      }
    }

    writeManifest(this.config.checkpointDir, manifest)
  }

  /**
   * 将内容写入当前消息对应的 files/ 备份目录。
   */
  private writeBackupContent(
    relPath: string,
    content: Buffer | string
  ): void {
    if (!this.currentMessageId) return

    const filesDir = getFilesDir(
      this.config.checkpointDir,
      this.config.sessionId,
      this.currentMessageId
    )
    mkdirSync(filesDir, { recursive: true })

    const backupPath = join(filesDir, relPath)
    mkdirSync(dirname(backupPath), { recursive: true })
    // 不带 encoding：Buffer 字节级写入，二进制安全
    writeFileSync(backupPath, content)
  }

  /**
   * 基于内容和相对路径判断 bash 变更是否应跳过备份。
   *
   * 返回 SkippedFileInfo 表示需要跳过，null 表示可以备份。
   */
  private checkContentShouldSkipBackup(
    relPath: string,
    content: Buffer | string
  ): SkippedFileInfo | null {
    if (isExcludedPath(relPath)) {
      return { path: relPath, reason: 'excluded', bytes: 0 }
    }

    const bytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, 'utf8')
    const maxBytes = this.getMaxBackupFileBytes()
    if (bytes > maxBytes) {
      return { path: relPath, reason: 'oversized', bytes }
    }

    return null
  }
}
