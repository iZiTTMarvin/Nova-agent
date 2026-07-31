/**
 * worktree 副作用凭证：创建/清理对账。
 * 落盘路径：.nova/compose/runs/<runId>/worktree-receipts/<effectId>.json
 *
 * resume：
 * - directory 仍在且 branch/baseSha 匹配 → 复用，不重建
 * - directory 已删 → retryable 重建，否则 blocked
 * - cleanup 后标 cleaned
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from '../../storage/atomicFile'
import { effectIdFromKey, type SideEffectCtx } from './sideEffectCtx'

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type WorktreeEffectStatus = 'prepared' | 'committed' | 'cleaned'

export interface WorktreeEffectReceipt {
  effectId: string
  runId: string
  stepId?: string
  idempotencyKey?: string
  directory: string
  branch: string
  baseSha: string
  status: WorktreeEffectStatus
  at: number
}

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId.includes('..') || runId.includes('/') || runId.includes('\\')) {
    throw new Error(`非法 runId: ${runId}`)
  }
}

function worktreeReceiptsDir(workspaceRoot: string, runId: string): string {
  assertSafeRunId(runId)
  return join(workspaceRoot, '.nova', 'compose', 'runs', runId, 'worktree-receipts')
}

export function worktreeEffectId(stepCtx: SideEffectCtx): string {
  return effectIdFromKey(`${stepCtx.idempotencyKey}:worktree`)
}

export function readWorktreeReceipt(
  workspaceRoot: string,
  runId: string,
  effectId: string
): WorktreeEffectReceipt | null {
  assertSafeRunId(runId)
  const file = join(worktreeReceiptsDir(workspaceRoot, runId), `${effectId}.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as WorktreeEffectReceipt
  } catch {
    return null
  }
}

/** 按目录反查（cleanup 时可能只有 directory） */
export function findWorktreeReceiptByDirectory(
  workspaceRoot: string,
  runId: string,
  directory: string
): WorktreeEffectReceipt | null {
  assertSafeRunId(runId)
  const dir = worktreeReceiptsDir(workspaceRoot, runId)
  if (!existsSync(dir)) return null
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as WorktreeEffectReceipt
      if (raw.directory === directory) return raw
    } catch {
      /* skip corrupt */
    }
  }
  return null
}

export function writeWorktreeReceipt(
  workspaceRoot: string,
  receipt: WorktreeEffectReceipt
): void {
  assertSafeRunId(receipt.runId)
  const dir = worktreeReceiptsDir(workspaceRoot, receipt.runId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(
    join(dir, `${receipt.effectId}.json`),
    JSON.stringify(receipt, null, 2)
  )
}

export function commitWorktreeReceipt(params: {
  workspaceRoot: string
  stepCtx: SideEffectCtx
  directory: string
  branch: string
  baseSha: string
}): WorktreeEffectReceipt {
  const effectId = worktreeEffectId(params.stepCtx)
  const receipt: WorktreeEffectReceipt = {
    effectId,
    runId: params.stepCtx.runId,
    stepId: params.stepCtx.stepId,
    idempotencyKey: params.stepCtx.idempotencyKey,
    directory: params.directory,
    branch: params.branch,
    baseSha: params.baseSha,
    status: 'committed',
    at: Date.now()
  }
  writeWorktreeReceipt(params.workspaceRoot, receipt)
  return receipt
}

export function markWorktreeCleaned(
  workspaceRoot: string,
  runId: string,
  effectIdOrDirectory: { effectId?: string; directory?: string; stepCtx?: SideEffectCtx }
): WorktreeEffectReceipt | null {
  let receipt: WorktreeEffectReceipt | null = null
  if (effectIdOrDirectory.stepCtx) {
    receipt = readWorktreeReceipt(
      workspaceRoot,
      runId,
      worktreeEffectId(effectIdOrDirectory.stepCtx)
    )
  } else if (effectIdOrDirectory.effectId) {
    receipt = readWorktreeReceipt(workspaceRoot, runId, effectIdOrDirectory.effectId)
  } else if (effectIdOrDirectory.directory) {
    receipt = findWorktreeReceiptByDirectory(
      workspaceRoot,
      runId,
      effectIdOrDirectory.directory
    )
  }
  if (!receipt) return null
  const updated: WorktreeEffectReceipt = {
    ...receipt,
    status: 'cleaned',
    at: Date.now()
  }
  writeWorktreeReceipt(workspaceRoot, updated)
  return updated
}

/**
 * resume 时若目录仍在且元数据匹配，返回可复用的 receipt。
 */
export function tryReuseWorktreeReceipt(params: {
  workspaceRoot: string
  stepCtx: SideEffectCtx
}): WorktreeEffectReceipt | null {
  const effectId = worktreeEffectId(params.stepCtx)
  const existing = readWorktreeReceipt(
    params.workspaceRoot,
    params.stepCtx.runId,
    effectId
  )
  if (!existing || existing.status === 'cleaned') return null
  if (existing.status !== 'committed' && existing.status !== 'prepared') return null
  if (!existsSync(existing.directory)) return null
  return existing
}
