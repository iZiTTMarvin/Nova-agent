/**
 * bash 副作用凭证：命令 hash + 退出结果。
 * 落盘路径：.nova/compose/runs/<runId>/bash-receipts/<effectId>.json
 *
 * 幂等语义：
 * - policy.idempotent=true 且 commandHash 匹配 + exitCode=0 → resume 复用
 * - 非幂等 + resumingInterrupted 且无成功 receipt → blocked（at-least-once 禁止自动重放）
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from '../../storage/atomicFile'
import { effectIdFromKey, type SideEffectCtx } from './sideEffectCtx'

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type BashEffectStatus = 'prepared' | 'committed'

export interface BashEffectReceipt {
  effectId: string
  runId: string
  stepId?: string
  idempotencyKey?: string
  commandHash: string
  exitCode: number
  /** stdout 的 sha256，不存全文 */
  stdoutDigest: string
  /** 短预览（截断），便于诊断 */
  stdoutPreview: string
  status: BashEffectStatus
  at: number
}

export interface BashHookResult {
  exitCode: number
  stdout: string
  stderr: string
  passed: boolean
  /** 是否命中已有 receipt 而跳过执行 */
  reused?: boolean
}

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId.includes('..') || runId.includes('/') || runId.includes('\\')) {
    throw new Error(`非法 runId: ${runId}`)
  }
}

function bashReceiptsDir(workspaceRoot: string, runId: string): string {
  assertSafeRunId(runId)
  return join(workspaceRoot, '.nova', 'compose', 'runs', runId, 'bash-receipts')
}

export function hashCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex')
}

function digestStdout(stdout: string): { digest: string; preview: string } {
  return {
    digest: createHash('sha256').update(stdout).digest('hex'),
    preview: stdout.length > 200 ? stdout.slice(0, 200) + '…' : stdout
  }
}

export function bashEffectId(stepCtx: SideEffectCtx, commandHash: string): string {
  // 同一 step 可能改命令：effectId 纳入 commandHash 前 16 位，避免串单
  return effectIdFromKey(`${stepCtx.idempotencyKey}:bash:${commandHash.slice(0, 16)}`)
}

export function readBashReceipt(
  workspaceRoot: string,
  runId: string,
  effectId: string
): BashEffectReceipt | null {
  assertSafeRunId(runId)
  const file = join(bashReceiptsDir(workspaceRoot, runId), `${effectId}.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as BashEffectReceipt
  } catch {
    return null
  }
}

export function writeBashReceipt(
  workspaceRoot: string,
  receipt: BashEffectReceipt
): void {
  assertSafeRunId(receipt.runId)
  const dir = bashReceiptsDir(workspaceRoot, receipt.runId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(
    join(dir, `${receipt.effectId}.json`),
    JSON.stringify(receipt, null, 2)
  )
}

/** 构造并落盘 committed bash receipt */
export function commitBashReceipt(params: {
  workspaceRoot: string
  stepCtx: SideEffectCtx
  command: string
  exitCode: number
  stdout: string
}): BashEffectReceipt {
  const commandHash = hashCommand(params.command)
  const effectId = bashEffectId(params.stepCtx, commandHash)
  const { digest, preview } = digestStdout(params.stdout)
  const receipt: BashEffectReceipt = {
    effectId,
    runId: params.stepCtx.runId,
    stepId: params.stepCtx.stepId,
    idempotencyKey: params.stepCtx.idempotencyKey,
    commandHash,
    exitCode: params.exitCode,
    stdoutDigest: digest,
    stdoutPreview: preview,
    status: 'committed',
    at: Date.now()
  }
  writeBashReceipt(params.workspaceRoot, receipt)
  return receipt
}

/**
 * resume 时尝试复用已有成功结果。
 * @returns 可复用的结果，或 null 表示需要执行 / 已判定不可复用
 */
export function tryReuseBashReceipt(params: {
  workspaceRoot: string
  stepCtx: SideEffectCtx
  command: string
}): BashHookResult | null {
  const commandHash = hashCommand(params.command)
  const effectId = bashEffectId(params.stepCtx, commandHash)
  const existing = readBashReceipt(params.workspaceRoot, params.stepCtx.runId, effectId)
  if (
    existing?.status === 'committed' &&
    existing.commandHash === commandHash &&
    existing.exitCode === 0
  ) {
    return {
      exitCode: 0,
      stdout: existing.stdoutPreview,
      stderr: '',
      passed: true,
      reused: true
    }
  }
  return null
}
