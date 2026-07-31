/**
 * integrate 副作用凭证：防止 resume 重复合并。
 * 落盘路径：.nova/compose/runs/<runId>/integrate-receipts/<effectId>.json
 *
 * resume：
 * - 已 committed → 跳过（幂等提交凭证）
 * - 无 receipt → 正常执行（首次）或中断恢复时 blocked（非幂等）
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from '../../storage/atomicFile'
import { effectIdFromKey, type SideEffectCtx } from './sideEffectCtx'

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type IntegrateEffectStatus = 'prepared' | 'committed'

export interface IntegrateEffectReceipt {
  effectId: string
  runId: string
  stepId?: string
  idempotencyKey?: string
  worktreeDirectory: string
  targetBranch?: string
  mergeCommitSha?: string | null
  /** agent 返回的摘要结果（可 JSON 序列化） */
  result?: unknown
  status: IntegrateEffectStatus
  at: number
}

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId.includes('..') || runId.includes('/') || runId.includes('\\')) {
    throw new Error(`非法 runId: ${runId}`)
  }
}

function integrateReceiptsDir(workspaceRoot: string, runId: string): string {
  assertSafeRunId(runId)
  return join(workspaceRoot, '.nova', 'compose', 'runs', runId, 'integrate-receipts')
}

export function integrateEffectId(stepCtx: SideEffectCtx): string {
  return effectIdFromKey(`${stepCtx.idempotencyKey}:integrate`)
}

export function readIntegrateReceipt(
  workspaceRoot: string,
  runId: string,
  effectId: string
): IntegrateEffectReceipt | null {
  assertSafeRunId(runId)
  const file = join(integrateReceiptsDir(workspaceRoot, runId), `${effectId}.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as IntegrateEffectReceipt
  } catch {
    return null
  }
}

export function writeIntegrateReceipt(
  workspaceRoot: string,
  receipt: IntegrateEffectReceipt
): void {
  assertSafeRunId(receipt.runId)
  const dir = integrateReceiptsDir(workspaceRoot, receipt.runId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(
    join(dir, `${receipt.effectId}.json`),
    JSON.stringify(receipt, null, 2)
  )
}

export function commitIntegrateReceipt(params: {
  workspaceRoot: string
  stepCtx: SideEffectCtx
  worktreeDirectory: string
  targetBranch?: string
  mergeCommitSha?: string | null
  result?: unknown
}): IntegrateEffectReceipt {
  const effectId = integrateEffectId(params.stepCtx)
  const receipt: IntegrateEffectReceipt = {
    effectId,
    runId: params.stepCtx.runId,
    stepId: params.stepCtx.stepId,
    idempotencyKey: params.stepCtx.idempotencyKey,
    worktreeDirectory: params.worktreeDirectory,
    targetBranch: params.targetBranch,
    mergeCommitSha: params.mergeCommitSha ?? null,
    result: params.result,
    status: 'committed',
    at: Date.now()
  }
  writeIntegrateReceipt(params.workspaceRoot, receipt)
  return receipt
}

export function tryReuseIntegrateReceipt(params: {
  workspaceRoot: string
  stepCtx: SideEffectCtx
}): IntegrateEffectReceipt | null {
  const effectId = integrateEffectId(params.stepCtx)
  const existing = readIntegrateReceipt(
    params.workspaceRoot,
    params.stepCtx.runId,
    effectId
  )
  if (existing?.status === 'committed') return existing
  return null
}
