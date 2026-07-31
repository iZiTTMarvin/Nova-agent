/** `.nova/workflow/runs/<runId>/` 是 Workflow 唯一持久化布局。 */
import { mkdirSync } from 'fs'
import { join } from 'path'

export function workflowRoot(workspaceRoot: string): string {
  return join(workspaceRoot, '.nova', 'workflow')
}

export function runsRoot(workspaceRoot: string): string {
  return join(workflowRoot(workspaceRoot), 'runs')
}

export function runDir(workspaceRoot: string, runId: string): string {
  return join(runsRoot(workspaceRoot), runId)
}

export function runLogPath(workspaceRoot: string, runId: string): string {
  return join(runDir(workspaceRoot, runId), 'log.txt')
}

export function runJournalPath(workspaceRoot: string, runId: string): string {
  return join(runDir(workspaceRoot, runId), 'journal.jsonl')
}

export function runMetadataPath(workspaceRoot: string, runId: string): string {
  return join(runDir(workspaceRoot, runId), 'run.json')
}

export function ensureRunDir(workspaceRoot: string, runId: string): string {
  const dir = runDir(workspaceRoot, runId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 生成 runId：YYYY-MM-DD-HHmmss。 */
export function generateRunId(now: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}
