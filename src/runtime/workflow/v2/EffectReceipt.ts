/**
 * 文件副作用凭证：安全回滚的唯一依据。
 *
 * 写文件协议：
 *   backup → prepared intent（fsync）→ 改目标文件 → 校验 afterHash → committed
 * receipt/backup 失败时禁止修改目标文件。
 *
 * 回滚：按 effect 逆序；用户改过 → conflict，绝不覆盖。
 * beforeCheckpointRef 只允许 run 目录内相对路径。
 */
import { createHash, createHmac } from 'crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { atomicWriteFileSync } from '../../storage/atomicFile'

export type FileEffectAction = 'create' | 'modify' | 'delete'
export type FileEffectStatus = 'prepared' | 'committed'

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface FileEffectReceipt {
  effectId: string
  runId: string
  stepId?: string
  idempotencyKey?: string
  /** 工作区内相对路径（正斜杠） */
  path: string
  action: FileEffectAction
  beforeHash: string | null
  /**
   * 改前备份：仅允许相对 run 目录的引用（如 effect-backups/xxx.bak）。
   * 禁止信任 receipt 中的任意绝对路径。
   */
  beforeCheckpointRef: string | null
  afterHash: string | null
  status: FileEffectStatus
  at: number
}

export type RollbackFileStatus =
  | 'restored'
  | 'deleted'
  | 'conflict'
  | 'skipped'
  | 'missing_backup'
  | 'corrupt_receipt'

export interface RollbackFileResult {
  path: string
  status: RollbackFileStatus
  reason?: string
}

export interface RollbackPreview {
  willRestore: string[]
  willDelete: string[]
  conflicts: string[]
  missingBackup: string[]
  corrupt: string[]
  /** 供 confirm 校验的 token，避免 TOCTOU */
  previewToken: string
}

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId.includes('..') || runId.includes('/') || runId.includes('\\')) {
    throw new Error(`非法 runId: ${runId}`)
  }
}

function runRoot(workspaceRoot: string, runId: string): string {
  assertSafeRunId(runId)
  return join(workspaceRoot, '.nova', 'compose', 'runs', runId)
}

function effectsDir(workspaceRoot: string, runId: string): string {
  return join(runRoot(workspaceRoot, runId), 'effects')
}

/** 解析并校验路径仍在 workspaceRoot 下；拒绝 symlink/junction 越界 */
export function resolveUnderWorkspace(workspaceRoot: string, relPath: string): string {
  if (relPath.includes('\0') || relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) {
    throw new Error(`拒绝绝对/非法路径: ${relPath}`)
  }
  if (relPath.split(/[/\\]/).includes('..')) {
    throw new Error(`路径逃逸: ${relPath}`)
  }
  const root = resolve(workspaceRoot)
  const abs = resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`路径逃逸工作区: ${relPath}`)
  }
  // 若已存在，检查 realpath 不越界（symlink/junction）
  if (existsSync(abs)) {
    try {
      const real = realpathSync(abs)
      if (real !== root && !real.startsWith(root + sep)) {
        throw new Error(`符号链接越界: ${relPath}`)
      }
      if (lstatSync(abs).isSymbolicLink()) {
        // 允许指向工作区内的链接；越界已在 realpath 检查
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('越界')) throw err
      // realpath 失败时保守拒绝
      throw new Error(`无法解析路径: ${relPath}`)
    }
  }
  return abs
}

function normalizeRel(workspaceRoot: string, absOrRel: string): string {
  const abs = resolve(absOrRel)
  const root = resolve(workspaceRoot)
  if (!abs.startsWith(root + sep) && abs !== root) {
    throw new Error(`路径逃逸工作区: ${absOrRel}`)
  }
  return relative(root, abs).split(sep).join('/')
}

/** 将 receipt 中的相对 backup 引用解析为绝对路径（必须在 run 目录内） */
export function resolveBackupRef(
  workspaceRoot: string,
  runId: string,
  ref: string | null
): string | null {
  if (!ref) return null
  // 拒绝绝对路径与 .. 
  if (ref.includes('..') || ref.startsWith('/') || /^[A-Za-z]:/.test(ref) || ref.includes('\0')) {
    throw new Error(`非法 beforeCheckpointRef: ${ref}`)
  }
  const base = runRoot(workspaceRoot, runId)
  const abs = resolve(base, ref)
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`backup 越界 run 目录: ${ref}`)
  }
  return abs
}

export function hashContent(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

export function hashFileIfExists(absPath: string): string | null {
  if (!existsSync(absPath)) return null
  return hashContent(readFileSync(absPath))
}

/** 记录一条文件副作用凭证（原子写）；可写 prepared 或 committed */
export function recordFileEffect(
  workspaceRoot: string,
  receipt: FileEffectReceipt
): void {
  assertSafeRunId(receipt.runId)
  // 落盘前再校验 path
  resolveUnderWorkspace(workspaceRoot, receipt.path)
  const dir = effectsDir(workspaceRoot, receipt.runId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, `${receipt.effectId}.json`)
  atomicWriteFileSync(file, JSON.stringify(receipt, null, 2))
}

/** prepared → committed（写文件成功后调用） */
export function commitFileEffect(
  workspaceRoot: string,
  runId: string,
  effectId: string,
  patch: { afterHash: string }
): void {
  const file = join(effectsDir(workspaceRoot, runId), `${effectId}.json`)
  if (!existsSync(file)) {
    throw new Error(`effect receipt 不存在: ${effectId}`)
  }
  const receipt = JSON.parse(readFileSync(file, 'utf-8')) as FileEffectReceipt
  receipt.status = 'committed'
  receipt.afterHash = patch.afterHash
  receipt.at = Date.now()
  atomicWriteFileSync(file, JSON.stringify(receipt, null, 2))
}

export interface ListEffectsResult {
  effects: FileEffectReceipt[]
  corruptIds: string[]
}

/** 列出某 run 的全部 effect；损坏条目记入 corruptIds，不得静默跳过 */
export function listFileEffectsDetailed(
  workspaceRoot: string,
  runId: string
): ListEffectsResult {
  assertSafeRunId(runId)
  const dir = effectsDir(workspaceRoot, runId)
  if (!existsSync(dir)) return { effects: [], corruptIds: [] }
  const out: FileEffectReceipt[] = []
  const corruptIds: string[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as FileEffectReceipt
      // 重新校验 path
      resolveUnderWorkspace(workspaceRoot, raw.path)
      if (!raw.status) raw.status = 'committed' // 旧 receipt 兼容
      out.push(raw)
    } catch {
      corruptIds.push(name.replace(/\.json$/, ''))
    }
  }
  out.sort((a, b) => a.at - b.at)
  return { effects: out, corruptIds }
}

export function listFileEffects(workspaceRoot: string, runId: string): FileEffectReceipt[] {
  return listFileEffectsDetailed(workspaceRoot, runId).effects
}

function signPreviewToken(
  runId: string,
  effects: FileEffectReceipt[],
  fileHashes: Record<string, string | null>
): string {
  const payload = JSON.stringify({
    runId,
    effects: effects.map(e => ({
      id: e.effectId,
      path: e.path,
      after: e.afterHash,
      before: e.beforeHash,
      status: e.status
    })),
    fileHashes
  })
  return createHmac('sha256', 'nova-rollback-preview').update(payload).digest('hex')
}

/**
 * 按当前磁盘状态预览回滚（虚拟状态逆序模拟，支持同文件多次修改）。
 */
export function previewRollback(
  workspaceRoot: string,
  runId: string
): RollbackPreview {
  const { effects, corruptIds } = listFileEffectsDetailed(workspaceRoot, runId)
  const preview: RollbackPreview = {
    willRestore: [],
    willDelete: [],
    conflicts: [],
    missingBackup: [],
    corrupt: [...corruptIds],
    previewToken: ''
  }

  // 虚拟文件状态：path → 当前模拟 hash（null=不存在）
  const virtual = new Map<string, string | null>()
  const fileHashes: Record<string, string | null> = {}
  for (const e of effects) {
    if (!virtual.has(e.path)) {
      const abs = resolveUnderWorkspace(workspaceRoot, e.path)
      const h = hashFileIfExists(abs)
      virtual.set(e.path, h)
      fileHashes[e.path] = h
    }
  }

  for (const e of [...effects].reverse()) {
    if (e.status === 'prepared') {
      // prepared 未 committed：按崩溃恢复矩阵，不自动回滚目标
      continue
    }
    const current = virtual.get(e.path) ?? null
    if (e.action === 'create') {
      if (current === null) {
        // 已不存在
      } else if (e.afterHash && current === e.afterHash) {
        preview.willDelete.push(e.path)
        virtual.set(e.path, null)
      } else {
        preview.conflicts.push(e.path)
      }
    } else if (e.action === 'modify') {
      if (e.afterHash && current === e.afterHash) {
        try {
          const bak = resolveBackupRef(workspaceRoot, runId, e.beforeCheckpointRef)
          if (bak && existsSync(bak)) {
            preview.willRestore.push(e.path)
            virtual.set(e.path, e.beforeHash)
          } else if (e.beforeHash === null) {
            preview.willDelete.push(e.path)
            virtual.set(e.path, null)
          } else {
            preview.missingBackup.push(e.path)
          }
        } catch {
          preview.missingBackup.push(e.path)
        }
      } else if (e.beforeHash && current === e.beforeHash) {
        // 已是改前
      } else {
        preview.conflicts.push(e.path)
      }
    } else if (e.action === 'delete') {
      if (current === null) {
        try {
          const bak = resolveBackupRef(workspaceRoot, runId, e.beforeCheckpointRef)
          if (bak && existsSync(bak)) {
            preview.willRestore.push(e.path)
            virtual.set(e.path, e.beforeHash)
          } else {
            preview.missingBackup.push(e.path)
          }
        } catch {
          preview.missingBackup.push(e.path)
        }
      } else {
        preview.conflicts.push(e.path)
      }
    }
  }

  preview.previewToken = signPreviewToken(runId, effects, fileHashes)
  return preview
}

export interface ConfirmRollbackOptions {
  /** 必须与最近一次 preview 的 token 一致 */
  previewToken?: string
}

/**
 * 按 effect 逆序安全回滚。
 * conflict / missing_backup / corrupt → ok=false。
 */
export function confirmRollback(
  workspaceRoot: string,
  runId: string,
  options: ConfirmRollbackOptions = {}
): { ok: boolean; results: RollbackFileResult[]; preview: RollbackPreview } {
  const preview = previewRollback(workspaceRoot, runId)
  if (options.previewToken && options.previewToken !== preview.previewToken) {
    return {
      ok: false,
      results: [
        {
          path: '*',
          status: 'conflict',
          reason: 'previewToken 不匹配（文件可能已变化，请重新 preview）'
        }
      ],
      preview
    }
  }

  const { effects, corruptIds } = listFileEffectsDetailed(workspaceRoot, runId)
  const results: RollbackFileResult[] = []
  for (const id of corruptIds) {
    results.push({ path: id, status: 'corrupt_receipt', reason: 'receipt 损坏，拒绝静默跳过' })
  }

  for (const e of [...effects].reverse()) {
    if (e.status === 'prepared') {
      results.push({ path: e.path, status: 'skipped', reason: 'prepared 未提交，跳过回滚' })
      continue
    }
    let abs: string
    try {
      abs = resolveUnderWorkspace(workspaceRoot, e.path)
    } catch (err) {
      results.push({
        path: e.path,
        status: 'corrupt_receipt',
        reason: err instanceof Error ? err.message : 'path 校验失败'
      })
      continue
    }
    const current = hashFileIfExists(abs)

    if (e.action === 'create') {
      if (current === null) {
        results.push({ path: e.path, status: 'skipped', reason: '文件已不存在' })
        continue
      }
      if (e.afterHash && current === e.afterHash) {
        unlinkSync(abs)
        results.push({ path: e.path, status: 'deleted' })
      } else {
        results.push({ path: e.path, status: 'conflict', reason: '用户已修改新建文件' })
      }
      continue
    }

    if (e.action === 'modify') {
      if (e.afterHash && current === e.afterHash) {
        try {
          const bak = resolveBackupRef(workspaceRoot, runId, e.beforeCheckpointRef)
          if (bak && existsSync(bak)) {
            const dir = dirname(abs)
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            writeFileSync(abs, readFileSync(bak))
            results.push({ path: e.path, status: 'restored' })
          } else if (e.beforeHash === null) {
            unlinkSync(abs)
            results.push({ path: e.path, status: 'deleted' })
          } else {
            results.push({ path: e.path, status: 'missing_backup', reason: '缺少改前备份' })
          }
        } catch (err) {
          results.push({
            path: e.path,
            status: 'missing_backup',
            reason: err instanceof Error ? err.message : 'backup 无效'
          })
        }
      } else if (e.beforeHash && current === e.beforeHash) {
        results.push({ path: e.path, status: 'skipped', reason: '已是改前状态' })
      } else {
        results.push({ path: e.path, status: 'conflict', reason: '用户已修改该文件' })
      }
      continue
    }

    if (e.action === 'delete') {
      if (current === null) {
        try {
          const bak = resolveBackupRef(workspaceRoot, runId, e.beforeCheckpointRef)
          if (bak && existsSync(bak)) {
            const dir = dirname(abs)
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            writeFileSync(abs, readFileSync(bak))
            results.push({ path: e.path, status: 'restored' })
          } else {
            results.push({ path: e.path, status: 'missing_backup', reason: '缺少删除前备份' })
          }
        } catch (err) {
          results.push({
            path: e.path,
            status: 'missing_backup',
            reason: err instanceof Error ? err.message : 'backup 无效'
          })
        }
      } else {
        results.push({ path: e.path, status: 'conflict', reason: '路径已存在（用户可能已恢复）' })
      }
    }
  }

  const failed = results.some(
    r =>
      r.status === 'conflict' ||
      r.status === 'missing_backup' ||
      r.status === 'corrupt_receipt'
  )
  return { ok: !failed && preview.corrupt.length === 0, results, preview }
}

/** 便捷：构造 receipt（默认 prepared） */
export function buildFileEffectReceipt(params: {
  workspaceRoot: string
  runId: string
  stepId?: string
  idempotencyKey?: string
  absPath: string
  action: FileEffectAction
  beforeHash: string | null
  beforeCheckpointRef: string | null
  afterHash: string | null
  effectId?: string
  status?: FileEffectStatus
}): FileEffectReceipt {
  assertSafeRunId(params.runId)
  const rel = normalizeRel(params.workspaceRoot, params.absPath)
  return {
    effectId: params.effectId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    runId: params.runId,
    stepId: params.stepId,
    idempotencyKey: params.idempotencyKey,
    path: rel,
    action: params.action,
    beforeHash: params.beforeHash,
    beforeCheckpointRef: params.beforeCheckpointRef,
    afterHash: params.afterHash,
    status: params.status ?? 'prepared',
    at: Date.now()
  }
}
