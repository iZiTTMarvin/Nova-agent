/**
 * `.nova/compose/` 产物路径约定
 */
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'

export function composeRoot(workspaceRoot: string): string {
  return join(workspaceRoot, '.nova', 'compose')
}

export function runDir(workspaceRoot: string, runId: string): string {
  return join(composeRoot(workspaceRoot), runId)
}

export function runLogPath(workspaceRoot: string, runId: string): string {
  return join(runDir(workspaceRoot, runId), 'log.txt')
}

export function runJournalPath(workspaceRoot: string, runId: string): string {
  return join(runDir(workspaceRoot, runId), 'journal.jsonl')
}

export function statePath(workspaceRoot: string): string {
  return join(composeRoot(workspaceRoot), 'state.json')
}

/** 确保 run 目录存在 */
export function ensureRunDir(workspaceRoot: string, runId: string): string {
  const dir = runDir(workspaceRoot, runId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function ensureComposeRoot(workspaceRoot: string): string {
  const root = composeRoot(workspaceRoot)
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'specs'), { recursive: true })
  mkdirSync(join(root, 'plans'), { recursive: true })
  mkdirSync(join(root, 'reports'), { recursive: true })
  return root
}

/** 生成 runId：YYYY-MM-DD-HHmmss，冲突时追加短后缀 */
export function generateRunId(now: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const base =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return base
}

export function pathExists(p: string): boolean {
  return existsSync(p)
}
