/**
 * v2 step / events / manifest 原子落盘
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { createHash } from 'node:crypto'
import { dirname } from 'path'
import { atomicWriteFileSync } from '../../storage/atomicFile'
import { canonical } from '../journal'
import {
  ensureRunDir,
  runEventsPath,
  runStepPath,
  runStepsDir,
  runDirV2
} from '../paths'
import type { StepRecord, WorkflowV2Manifest } from './types'

function manifestPath(workspaceRoot: string, runId: string): string {
  return `${runDirV2(workspaceRoot, runId)}/manifest.v2.json`
}

export function computeInputHash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
}

export function makeIdempotencyKey(runId: string, stepId: string, inputHash: string): string {
  return `${runId}:${stepId}:${inputHash}`
}

export function writeManifest(
  workspaceRoot: string,
  manifest: WorkflowV2Manifest
): void {
  ensureRunDir(workspaceRoot, manifest.runId)
  atomicWriteFileSync(manifestPath(workspaceRoot, manifest.runId), JSON.stringify(manifest, null, 2))
}

export function readManifest(
  workspaceRoot: string,
  runId: string
): WorkflowV2Manifest | null {
  const p = manifestPath(workspaceRoot, runId)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as WorkflowV2Manifest
  } catch {
    return null
  }
}

export function writeStepRecord(
  workspaceRoot: string,
  runId: string,
  record: StepRecord
): void {
  ensureRunDir(workspaceRoot, runId)
  const path = runStepPath(workspaceRoot, runId, sanitizeStepFileName(record.stepId))
  atomicWriteFileSync(path, JSON.stringify(record, null, 2))
}

export function readStepRecord(
  workspaceRoot: string,
  runId: string,
  stepId: string
): StepRecord | null {
  const path = runStepPath(workspaceRoot, runId, sanitizeStepFileName(stepId))
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as StepRecord
  } catch {
    return null
  }
}

/** 列出已落盘的全部 step（文件名反解 stepId 不可靠时以内容为准） */
export function listStepRecords(workspaceRoot: string, runId: string): StepRecord[] {
  const dir = runStepsDir(workspaceRoot, runId)
  if (!existsSync(dir)) return []
  const out: StepRecord[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = readFileSync(`${dir}/${name}`, 'utf-8')
      out.push(JSON.parse(raw) as StepRecord)
    } catch {
      /* 损坏跳过 */
    }
  }
  return out
}

export type WorkflowV2Event =
  | { t: 'step_started'; stepId: string; inputHash: string; at: string }
  | { t: 'step_committed'; stepId: string; inputHash: string; at: string }
  | { t: 'step_failed'; stepId: string; inputHash: string; error: string; at: string }
  | { t: 'run_status'; status: string; at: string }

/** append-only events；末行损坏可跳过 */
export function appendV2Event(
  workspaceRoot: string,
  runId: string,
  event: WorkflowV2Event
): void {
  ensureRunDir(workspaceRoot, runId)
  const path = runEventsPath(workspaceRoot, runId)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(event) + '\n', 'utf-8')
}

export function loadV2Events(workspaceRoot: string, runId: string): WorkflowV2Event[] {
  const path = runEventsPath(workspaceRoot, runId)
  if (!existsSync(path)) return []
  const events: WorkflowV2Event[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as WorkflowV2Event)
    } catch {
      /* 末行损坏跳过 */
    }
  }
  return events
}

/** stepId 可能含冒号等，文件名需安全 */
function sanitizeStepFileName(stepId: string): string {
  return stepId.replace(/[^0-9A-Za-z._-]+/g, '_')
}
