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
  version: 1
  runId: string
  workflow: string
  sessionId?: string
  status: WorkflowRunStatus
  phase: string
  startedAt: string
  updatedAt: string
  error?: string
}

export function isSafeWorkflowRunId(runId: string): boolean {
  return SAFE_RUN_ID.test(runId)
}

function assertSafeWorkflowRunId(runId: string): void {
  if (!isSafeWorkflowRunId(runId)) {
    throw new Error(`invalid workflow runId: ${JSON.stringify(runId)}`)
  }
}

export function readWorkflowRunMetadata(
  workspaceRoot: string,
  runId: string
): WorkflowRunMetadata | null {
  if (!isSafeWorkflowRunId(runId)) return null
  const path = runMetadataPath(workspaceRoot, runId)
  if (!existsSync(path)) return null
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const metadata = value as Partial<WorkflowRunMetadata>
    if (
      metadata.version !== 1 ||
      metadata.runId !== runId ||
      typeof metadata.workflow !== 'string' ||
      typeof metadata.status !== 'string' ||
      typeof metadata.phase !== 'string' ||
      typeof metadata.startedAt !== 'string' ||
      typeof metadata.updatedAt !== 'string'
    ) {
      return null
    }
    if (!['running', 'completed', 'failed', 'cancelled'].includes(metadata.status)) {
      return null
    }
    if (
      metadata.sessionId !== undefined &&
      typeof metadata.sessionId !== 'string'
    ) {
      return null
    }
    if (metadata.error !== undefined && typeof metadata.error !== 'string') {
      return null
    }
    return metadata as WorkflowRunMetadata
  } catch {
    return null
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
