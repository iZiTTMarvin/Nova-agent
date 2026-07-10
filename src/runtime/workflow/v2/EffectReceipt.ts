/**
 * 文件副作用凭证：安全回滚的唯一依据。
 * 回滚按 effect 逆序执行；用户后续改过的文件标 conflict，绝不覆盖。
 */
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { atomicWriteFileSync } from '../../storage/atomicFile'

export type FileEffectAction = 'create' | 'modify' | 'delete'

export interface FileEffectReceipt {
  effectId: string
  runId: string
  stepId?: string
  /** 稳定幂等键（来自 StepEngine） */
  idempotencyKey?: string
  /** 工作区内相对路径（正斜杠） */
  path: string
  action: FileEffectAction
  /** 改动前内容 hash；新建为 null */
  beforeHash: string | null
  /** 改动前备份绝对路径（可选） */
  beforeCheckpointRef: string | null
  /** 改动后内容 hash；删除为 null */
  afterHash: string | null
  at: number
}

export type RollbackFileStatus = 'restored' | 'deleted' | 'conflict' | 'skipped' | 'missing_backup'

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
}

function effectsDir(workspaceRoot: string, runId: string): string {
  return join(workspaceRoot, '.nova', 'compose', 'runs', runId, 'effects')
}

function normalizeRel(workspaceRoot: string, absOrRel: string): string {
  const abs = resolve(absOrRel)
  const root = resolve(workspaceRoot)
  if (!abs.startsWith(root + sep) && abs !== root) {
    throw new Error(`路径逃逸工作区: ${absOrRel}`)
  }
  return relative(root, abs).split(sep).join('/')
}

export function hashContent(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

export function hashFileIfExists(absPath: string): string | null {
  if (!existsSync(absPath)) return null
  return hashContent(readFileSync(absPath))
}

/** 记录一条文件副作用凭证（原子写） */
export function recordFileEffect(
  workspaceRoot: string,
  receipt: FileEffectReceipt
): void {
  const dir = effectsDir(workspaceRoot, receipt.runId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, `${receipt.effectId}.json`)
  atomicWriteFileSync(file, JSON.stringify(receipt, null, 2))
}

/** 列出某 run 的全部 effect（按 at 升序） */
export function listFileEffects(workspaceRoot: string, runId: string): FileEffectReceipt[] {
  const dir = effectsDir(workspaceRoot, runId)
  if (!existsSync(dir)) return []
  const out: FileEffectReceipt[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), 'utf-8')) as FileEffectReceipt)
    } catch {
      /* 跳过损坏条目 */
    }
  }
  out.sort((a, b) => a.at - b.at)
  return out
}

/** 按当前磁盘状态预览回滚结果（不改文件） */
export function previewRollback(
  workspaceRoot: string,
  runId: string
): RollbackPreview {
  const effects = listFileEffects(workspaceRoot, runId)
  const preview: RollbackPreview = {
    willRestore: [],
    willDelete: [],
    conflicts: [],
    missingBackup: []
  }
  // 逆序模拟
  for (const e of [...effects].reverse()) {
    const abs = resolve(workspaceRoot, e.path)
    const current = hashFileIfExists(abs)
    if (e.action === 'create') {
      if (current === null) {
        preview.willDelete.push(e.path) // 已不存在，视为已删
      } else if (e.afterHash && current === e.afterHash) {
        preview.willDelete.push(e.path)
      } else {
        preview.conflicts.push(e.path)
      }
    } else if (e.action === 'modify') {
      if (e.afterHash && current === e.afterHash) {
        if (e.beforeCheckpointRef && existsSync(e.beforeCheckpointRef)) {
          preview.willRestore.push(e.path)
        } else if (e.beforeHash === null) {
          preview.willDelete.push(e.path)
        } else {
          preview.missingBackup.push(e.path)
        }
      } else if (e.beforeHash && current === e.beforeHash) {
        // 已是改前状态
      } else {
        preview.conflicts.push(e.path)
      }
    } else if (e.action === 'delete') {
      if (current === null) {
        if (e.beforeCheckpointRef && existsSync(e.beforeCheckpointRef)) {
          preview.willRestore.push(e.path)
        } else {
          preview.missingBackup.push(e.path)
        }
      } else {
        preview.conflicts.push(e.path)
      }
    }
  }
  return preview
}

/**
 * 按 effect 逆序安全回滚。
 * - 修改：仅当当前 hash === afterHash 才恢复
 * - 新建：仅当内容仍等于 afterHash 才删除
 * - 删除：仅当路径仍不存在才恢复
 * - 用户改过 → conflict，绝不覆盖
 */
export function confirmRollback(
  workspaceRoot: string,
  runId: string
): { ok: boolean; results: RollbackFileResult[]; preview: RollbackPreview } {
  const effects = listFileEffects(workspaceRoot, runId)
  const results: RollbackFileResult[] = []
  const preview = previewRollback(workspaceRoot, runId)

  for (const e of [...effects].reverse()) {
    const abs = resolve(workspaceRoot, e.path)
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
        if (e.beforeCheckpointRef && existsSync(e.beforeCheckpointRef)) {
          const dir = dirname(abs)
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          writeFileSync(abs, readFileSync(e.beforeCheckpointRef))
          results.push({ path: e.path, status: 'restored' })
        } else if (e.beforeHash === null) {
          unlinkSync(abs)
          results.push({ path: e.path, status: 'deleted' })
        } else {
          results.push({ path: e.path, status: 'missing_backup', reason: '缺少改前备份' })
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
        if (e.beforeCheckpointRef && existsSync(e.beforeCheckpointRef)) {
          const dir = dirname(abs)
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          writeFileSync(abs, readFileSync(e.beforeCheckpointRef))
          results.push({ path: e.path, status: 'restored' })
        } else {
          results.push({ path: e.path, status: 'missing_backup', reason: '缺少删除前备份' })
        }
      } else {
        results.push({ path: e.path, status: 'conflict', reason: '路径已存在（用户可能已恢复）' })
      }
    }
  }

  const hasHardFail = results.some(r => r.status === 'missing_backup')
  return { ok: !hasHardFail, results, preview }
}

/** 便捷：为工作区文件写 modify/create receipt（调用方负责 before 备份） */
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
}): FileEffectReceipt {
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
    at: Date.now()
  }
}
