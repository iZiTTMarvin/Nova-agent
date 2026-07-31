/**
 * `.nova/compose/` 产物路径约定
 *
 * v2 布局（每 run 独立）：
 *   .nova/compose/runs/<runId>/state.json
 *   .nova/compose/runs/<runId>/events.jsonl
 *   .nova/compose/runs/<runId>/steps/<stepId>.json
 *   .nova/compose/runs/<runId>/journal.jsonl
 *   .nova/compose/sessions/<sessionId>/current.json
 *
 * v1 兼容（阶段 6 前仍可读/可镜像写）：
 *   .nova/compose/state.json
 *   .nova/compose/<runId>/...
 */
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'

export function composeRoot(workspaceRoot: string): string {
  return join(workspaceRoot, '.nova', 'compose')
}

/** v2：runs 根目录 */
export function runsRoot(workspaceRoot: string): string {
  return join(composeRoot(workspaceRoot), 'runs')
}

/** v2：sessions 指针根目录 */
export function sessionsRoot(workspaceRoot: string): string {
  return join(composeRoot(workspaceRoot), 'sessions')
}

/**
 * 单 run 目录。
 * 优先 v2 `runs/<runId>`；若仅有 v1 `<runId>` 则返回 v1（兼容读取）。
 * 新建时一律用 v2。
 */
export function runDir(workspaceRoot: string, runId: string): string {
  const v2 = join(runsRoot(workspaceRoot), runId)
  if (existsSync(v2)) return v2
  const v1 = join(composeRoot(workspaceRoot), runId)
  if (existsSync(v1)) return v1
  return v2
}

/** 强制 v2 run 目录（写入侧） */
export function runDirV2(workspaceRoot: string, runId: string): string {
  return join(runsRoot(workspaceRoot), runId)
}

/** v1 run 目录（兼容） */
export function runDirV1(workspaceRoot: string, runId: string): string {
  return join(composeRoot(workspaceRoot), runId)
}

export function runLogPath(workspaceRoot: string, runId: string): string {
  return join(runDir(workspaceRoot, runId), 'log.txt')
}

export function runJournalPath(workspaceRoot: string, runId: string): string {
  return join(runDir(workspaceRoot, runId), 'journal.jsonl')
}

export function runEventsPath(workspaceRoot: string, runId: string): string {
  return join(runDirV2(workspaceRoot, runId), 'events.jsonl')
}

export function runStepsDir(workspaceRoot: string, runId: string): string {
  return join(runDirV2(workspaceRoot, runId), 'steps')
}

export function runStepPath(workspaceRoot: string, runId: string, stepId: string): string {
  return join(runStepsDir(workspaceRoot, runId), `${stepId}.json`)
}

/** v2：每 run 独立 state.json */
export function runStatePath(workspaceRoot: string, runId: string): string {
  return join(runDirV2(workspaceRoot, runId), 'state.json')
}

/**
 * v1 全局 state 路径（阶段 6 前保留兼容读写）。
 * 新写入会同时镜像到此路径，便于旧 UI/测试读取。
 */
export function statePath(workspaceRoot: string): string {
  return join(composeRoot(workspaceRoot), 'state.json')
}

/** 会话当前 run 指针 */
export function sessionCurrentPath(workspaceRoot: string, sessionId: string): string {
  return join(sessionsRoot(workspaceRoot), sessionId, 'current.json')
}

/** 确保 v2 run 目录（含 steps）存在 */
export function ensureRunDir(workspaceRoot: string, runId: string): string {
  const dir = runDirV2(workspaceRoot, runId)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'steps'), { recursive: true })
  return dir
}

export function ensureComposeRoot(workspaceRoot: string): string {
  const root = composeRoot(workspaceRoot)
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'specs'), { recursive: true })
  mkdirSync(join(root, 'plans'), { recursive: true })
  mkdirSync(join(root, 'reports'), { recursive: true })
  mkdirSync(runsRoot(workspaceRoot), { recursive: true })
  mkdirSync(sessionsRoot(workspaceRoot), { recursive: true })
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
