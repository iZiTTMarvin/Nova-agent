/** 审阅拒绝恢复：整批预检后写入，失败时用写前字节补偿。 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { dirname, join } from 'path'
import { canonicalizeTargetPath } from '../permissions/pathAccess'
import type { CheckpointManifest } from './types'
import { digestFileBytes } from './fileDigest'
import { getFilesDir, readManifest, writeManifest } from './manifest'

/** 单个拒绝目标：filePath 为工作区相对路径，expectedDigest 为用户审阅时看到的版本摘要 */
export interface ReviewRejectTarget {
  filePath: string
  /** 工作区文件原始字节 sha256 hex；null 表示当时文件不存在 */
  expectedDigest: string | null
}

/** 规划阶段单个文件的失败原因（整批零副作用） */
export interface ReviewPlanFailure {
  filePath: string
  error: string
}

interface PlannedFileOp {
  filePath: string
  /** restore = 用备份字节覆盖工作区；remove = 删除工作区文件（created） */
  action: 'restore' | 'remove'
  /** restore 的目标字节（checkpoint 备份内容） */
  content: Buffer | null
  /** 执行前工作区字节快照；null 表示文件原本不存在，补偿时删除 */
  beforeImage: Buffer | null
}

export interface ReviewRestorePlan {
  checkpointRoot: string
  workspaceRoot: string
  sessionId: string
  messageId: string
  ops: PlannedFileOp[]
  /** 全部文件成功恢复后要落盘的 manifest */
  nextManifest: CheckpointManifest
}

export type ReviewPlanResult =
  | { ok: true; plan: ReviewRestorePlan }
  | { ok: false; failures: ReviewPlanFailure[] }

/** 文件在你查看改动后又被修改过时的冲突文案 */
export const REVIEW_CONFLICT_MESSAGE =
  '文件在你查看改动后又被修改过，已停止恢复。请查看最新改动后再决定。'

/** 执行期的窄文件 I/O 端口；测试用它注入失败，不 mock Owner 本身 */
export interface ReviewRestoreIo {
  /** 读取文件字节；不存在返回 null */
  readFile(absPath: string): Buffer | null
  /** 独占创建并写入（'wx'），路径已存在时抛错 */
  createFileExclusive(absPath: string, bytes: Buffer): void
  /** 同目录 rename 覆盖目标 */
  rename(from: string, to: string): void
  /** 删除文件；不存在时静默 */
  removeFile(absPath: string): void
  /** 递归创建目录 */
  ensureDir(dir: string): void
  /** 持久化 manifest（原子写） */
  writeManifest(manifest: CheckpointManifest): void
}

/** 默认 I/O 实现：真实 fs + checkpoints manifest 原子写 */
export function createDefaultReviewRestoreIo(checkpointRoot: string): ReviewRestoreIo {
  return {
    readFile(absPath) {
      return existsSync(absPath) ? readFileSync(absPath) : null
    },
    createFileExclusive(absPath, bytes) {
      const fd = openSync(absPath, 'wx')
      try {
        writeFileSync(fd, bytes)
        closeSync(fd)
      } catch (err) {
        try { closeSync(fd) } catch { /* 保留原始错误 */ }
        try { unlinkSync(absPath) } catch { /* 失败由上层报告 */ }
        throw err
      }
    },
    rename(from, to) {
      renameSync(from, to)
    },
    removeFile(absPath) {
      if (existsSync(absPath)) unlinkSync(absPath)
    },
    ensureDir(dir) {
      mkdirSync(dir, { recursive: true })
    },
    writeManifest(manifest) {
      writeManifest(checkpointRoot, manifest)
    }
  }
}

/** 整批预检不写盘；请求内重复路径按首次出现去重。 */
export function planReviewReject(
  params: {
    checkpointRoot: string
    workspaceRoot: string
    sessionId: string
    messageId: string
    targets: ReviewRejectTarget[]
    /** 校验相对路径落在工作区内（沿用 DiffReviewService 的 isWithinWorkspace 口径） */
    isWithinWorkspace: (relPath: string) => boolean
  },
  io: ReviewRestoreIo
): ReviewPlanResult {
  const { checkpointRoot, workspaceRoot, sessionId, messageId, targets, isWithinWorkspace } = params
  const deduped = new Map<string, ReviewRejectTarget>()
  for (const target of targets) {
    if (!deduped.has(target.filePath)) deduped.set(target.filePath, target)
  }

  // 路径越界先整批拦下：越界目标永远不允许进入恢复流程
  const boundaryFailures: ReviewPlanFailure[] = []
  for (const relPath of deduped.keys()) {
    if (!isWithinWorkspace(relPath)) {
      boundaryFailures.push({
        filePath: relPath,
        error: `路径越界: "${relPath}" 位于工作区 "${workspaceRoot}" 之外`
      })
    }
  }
  if (boundaryFailures.length > 0) return { ok: false, failures: boundaryFailures }

  const manifest = readManifest(checkpointRoot, sessionId, messageId)
  if (!manifest) {
    return {
      ok: false,
      failures: [...deduped.values()].map(t => ({
        filePath: t.filePath,
        error: '找不到对应的 checkpoint'
      }))
    }
  }

  const filesDir = getFilesDir(checkpointRoot, sessionId, messageId)
  const failures: ReviewPlanFailure[] = []
  const ops: PlannedFileOp[] = []

  for (const target of deduped.values()) {
    const relPath = target.filePath
    const fail = (error: string): void => {
      failures.push({ filePath: relPath, error })
    }

    let action: PlannedFileOp['action']
    let content: Buffer | null = null
    if (manifest.modifiedFiles.includes(relPath) || manifest.deletedFiles.includes(relPath)) {
      const backup = io.readFile(join(filesDir, relPath))
      if (backup === null) {
        fail(
          manifest.backupPruned
            ? '该消息备份已被滚动清理（仅保留最近 checkpoint），无法恢复'
            : '备份文件不存在'
        )
        continue
      }
      action = 'restore'
      content = backup
    } else if (manifest.createdFiles.includes(relPath)) {
      action = 'remove'
    } else {
      fail('该文件不在当前消息的 checkpoint 中')
      continue
    }

    // 摘要校验：文件当前字节必须仍是用户审阅时看到的版本，否则覆盖会弄丢用户的新改动
    const beforeImage = io.readFile(join(workspaceRoot, relPath))
    const currentDigest = beforeImage === null ? null : digestFileBytes(beforeImage)
    if (currentDigest !== target.expectedDigest) {
      fail(REVIEW_CONFLICT_MESSAGE)
      continue
    }

    ops.push({ filePath: relPath, action, content, beforeImage })
  }

  if (failures.length > 0) return { ok: false, failures }

  const targetPaths = new Set(ops.map(op => op.filePath))
  const nextManifest: CheckpointManifest = {
    ...manifest,
    modifiedFiles: manifest.modifiedFiles.filter(f => !targetPaths.has(f)),
    createdFiles: manifest.createdFiles.filter(f => !targetPaths.has(f)),
    deletedFiles: manifest.deletedFiles.filter(f => !targetPaths.has(f)),
    fileReviews: {
      ...(manifest.fileReviews ?? {}),
      ...Object.fromEntries(ops.map(op => [op.filePath, 'rejected' as const]))
    }
  }
  if (
    nextManifest.modifiedFiles.length === 0 &&
    nextManifest.createdFiles.length === 0 &&
    nextManifest.deletedFiles.length === 0
  ) {
    nextManifest.status = 'rolled-back'
  }

  return {
    ok: true,
    plan: { checkpointRoot, workspaceRoot, sessionId, messageId, ops, nextManifest }
  }
}

/**
 * 执行期失败。compensated 为 true 表示已动过的文件全部回滚到 before-image；
 * 为 false 时 unrecoveredPaths 列出未能回滚的路径（文案不得声称已全部回滚）。
 */
export class ReviewRestoreError extends Error {
  constructor(
    message: string,
    readonly compensated: boolean,
    readonly unrecoveredPaths: string[],
    /** 首个失败目标，供批量入口归入 failed */
    readonly filePath: string | null
  ) {
    super(message)
    this.name = 'ReviewRestoreError'
  }
}

/** 写回后目标已含新字节（rename 已生效或校验不过）；区别于写前就失败的错误 */
class TargetWrittenError extends Error {}

/** Windows junction 上独占创建临时文件可能误报 EEXIST，先解析到真实目标目录。 */
function writeVerified(io: ReviewRestoreIo, absPath: string, bytes: Buffer, ownTemps: Set<string>): void {
  io.ensureDir(dirname(absPath))
  const resolved = canonicalizeTargetPath(absPath)
  if (!resolved.ok) throw new Error(resolved.reason)
  const targetPath = resolved.path
  const dir = dirname(targetPath)
  const tmpPath = join(dir, `.nova-restore-${randomBytes(8).toString('hex')}.tmp`)
  ownTemps.add(tmpPath)
  let created = false
  try {
    io.createFileExclusive(tmpPath, bytes)
    created = true
    io.rename(tmpPath, targetPath)
  } finally {
    ownTemps.delete(tmpPath)
    // rename 失败等情况：只删本操作创建出的临时文件（独占创建失败时该路径不属于我们）
    if (created) io.removeFile(tmpPath)
  }
  let written: Buffer | null
  try {
    written = io.readFile(targetPath)
  } catch (err) {
    throw new TargetWrittenError(
      `写回后读取失败：${absPath}（${err instanceof Error ? err.message : String(err)}）`
    )
  }
  if (written === null || !written.equals(bytes)) {
    throw new TargetWrittenError(`写回后校验失败：${absPath}`)
  }
}

/**
 * 执行拒绝恢复计划。逐文件恢复后最后写一次 manifest。
 * 任何写/删/核对/manifest 异常都抛出 ReviewRestoreError：补偿成功时
 * compensated=true；补偿自身失败时 compensated=false 且列出未回滚路径。
 */
export function executeReviewRestore(plan: ReviewRestorePlan, io: ReviewRestoreIo): void {
  const touched: PlannedFileOp[] = []
  const ownTemps = new Set<string>()

  const compensate = (): string[] => {
    const unrecovered: string[] = []
    for (const op of [...touched].reverse()) {
      const absPath = join(plan.workspaceRoot, op.filePath)
      try {
        if (op.beforeImage === null) {
          io.removeFile(absPath)
        } else {
          writeVerified(io, absPath, op.beforeImage, ownTemps)
        }
      } catch {
        unrecovered.push(op.filePath)
      }
    }
    return unrecovered
  }

  const fail = (opFilePath: string | null, cause: unknown): never => {
    for (const tmp of ownTemps) {
      try {
        io.removeFile(tmp)
      } catch {
        // 临时文件清理失败不掩盖主错误
      }
    }
    const reason = cause instanceof Error ? cause.message : String(cause)
    const unrecovered = compensate()
    for (const tmp of ownTemps) {
      try {
        io.removeFile(tmp)
      } catch {
        // 同上
      }
    }
    if (unrecovered.length > 0) {
      throw new ReviewRestoreError(
        `拒绝改动失败：${reason}；且回滚未完成，以下文件可能处于中间状态：${unrecovered.join(', ')}`,
        false,
        unrecovered,
        opFilePath
      )
    }
    throw new ReviewRestoreError(
      `拒绝改动失败：${reason}（已回滚本次修改的文件，工作区未改变）`,
      true,
      [],
      opFilePath
    )
  }

  for (const op of plan.ops) {
    const absPath = join(plan.workspaceRoot, op.filePath)
    try {
      if (op.action === 'remove') {
        io.removeFile(absPath)
      } else {
        writeVerified(io, absPath, op.content!, ownTemps)
      }
      touched.push(op)
    } catch (err) {
      // rename 已生效或读回核对不过时目标已含备份字节，同样要补偿；
      // 删除失败后目标可能仍是原字节，补偿写回 before-image 也是安全原状
      if (err instanceof TargetWrittenError || op.action === 'remove') {
        touched.push(op)
      }
      fail(op.filePath, err)
    }
  }

  try {
    io.writeManifest(plan.nextManifest)
  } catch (err) {
    fail(null, err)
  }
}
