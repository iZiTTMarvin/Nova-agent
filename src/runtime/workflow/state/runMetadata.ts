/**
 * WorkflowOrchestrator 的最小持久化元数据。
 *
 * 运行态真源仍是 WorkflowRun；这里保存的是进程重启后校验 resume 所需的快照，
 * 不复制阶段结果、任务状态或 journal 内容。
 */
import { existsSync, readFileSync } from 'fs'
import { atomicWriteFileSync } from '../../storage/atomicFile'
import type { WorkflowRunStatus } from '../../../shared/workflow/types'
import { ensureRunDir, runMetadataPath } from './paths'

const SAFE_RUN_ID = /^[0-9A-Za-z._-]+$/

export interface WorkflowRunMetadata {
  version: 2
  runId: string
  workflow: string
  sessionId: string
  parentRunId: string
  parentMessageId: string
  parentToolCallId: string
  status: WorkflowRunStatus
  phase: string
  startedAt: string
  updatedAt: string
  error?: string
}

export type WorkflowRunMetadataRead =
  | { kind: 'current'; metadata: WorkflowRunMetadata }
  | { kind: 'legacy' }
  | { kind: 'missing' }
  | { kind: 'invalid' }

export function isSafeWorkflowRunId(runId: string): boolean {
  return SAFE_RUN_ID.test(runId)
}

function assertSafeWorkflowRunId(runId: string): void {
  if (!isSafeWorkflowRunId(runId)) {
    throw new Error(`invalid workflow runId: ${JSON.stringify(runId)}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWorkflowRunStatus(value: unknown): value is WorkflowRunStatus {
  return typeof value === 'string' &&
    ['running', 'completed', 'failed', 'cancelled'].includes(value)
}

export function readWorkflowRunMetadata(
  workspaceRoot: string,
  runId: string
): WorkflowRunMetadata | null {
  const result = inspectWorkflowRunMetadata(workspaceRoot, runId)
  return result.kind === 'current' ? result.metadata : null
}

/** 区分旧版与损坏/缺失元数据，让 resume 能给出真实且 fail-closed 的错误。 */
export function inspectWorkflowRunMetadata(
  workspaceRoot: string,
  runId: string
): WorkflowRunMetadataRead {
  if (!isSafeWorkflowRunId(runId)) return { kind: 'invalid' }
  const path = runMetadataPath(workspaceRoot, runId)
  if (!existsSync(path)) return { kind: 'missing' }
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!isRecord(value)) return { kind: 'invalid' }
    const metadata = value
    if (metadata.version === 1 && metadata.runId === runId) {
      return { kind: 'legacy' }
    }
    if (
      metadata.version !== 2 ||
      metadata.runId !== runId ||
      typeof metadata.workflow !== 'string' ||
      typeof metadata.sessionId !== 'string' ||
      typeof metadata.parentRunId !== 'string' ||
      typeof metadata.parentMessageId !== 'string' ||
      typeof metadata.parentToolCallId !== 'string' ||
      !isWorkflowRunStatus(metadata.status) ||
      typeof metadata.phase !== 'string' ||
      typeof metadata.startedAt !== 'string' ||
      typeof metadata.updatedAt !== 'string'
    ) {
      return { kind: 'invalid' }
    }
    if (metadata.error !== undefined && typeof metadata.error !== 'string') {
      return { kind: 'invalid' }
    }
    return {
      kind: 'current',
      metadata: {
        version: 2,
        runId,
        workflow: metadata.workflow,
        sessionId: metadata.sessionId,
        parentRunId: metadata.parentRunId,
        parentMessageId: metadata.parentMessageId,
        parentToolCallId: metadata.parentToolCallId,
        status: metadata.status,
        phase: metadata.phase,
        startedAt: metadata.startedAt,
        updatedAt: metadata.updatedAt,
        ...(metadata.error !== undefined ? { error: metadata.error } : {})
      }
    }
  } catch {
    return { kind: 'invalid' }
  }
}

export function writeWorkflowRunMetadata(
  workspaceRoot: string,
  metadata: WorkflowRunMetadata
): void {
  assertSafeWorkflowRunId(metadata.runId)
  ensureRunDir(workspaceRoot, metadata.runId)
  atomicWriteFileSync(
    runMetadataPath(workspaceRoot, metadata.runId),
    JSON.stringify(metadata, null, 2)
  )
}
