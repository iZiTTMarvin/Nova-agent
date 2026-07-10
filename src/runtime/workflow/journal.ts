/**
 * agent() 结果 journal：同步落盘，供 resume 跳过已成功调用。
 * inputHash 纳入 prompt/agentType/model/schema/phase/tools/isolation/timeoutMs。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { runJournalPath } from './paths'
import { atomicWriteFileSync } from '../storage/atomicFile'

/** 递归排序对象键，保证 JSON.stringify 与字段书写顺序无关 */
export function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonical)
  const obj = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((k) => [k, canonical(obj[k])])
  )
}

export interface JournalKeyOpts {
  agentType?: string
  model?: unknown
  schema?: unknown
  phase?: string
  /** 工具白名单：必须纳入 hash，避免同 prompt 不同 tools 错误复用 */
  tools?: string[] | null
  /** worktree / none：必须纳入 hash */
  isolation?: string | null
  /** 超时：必须纳入 hash */
  timeoutMs?: number | null
}

/**
 * 内容哈希：纳入会影响副作用的全部字段。
 * label 仍排除（仅展示用）；tools/isolation/timeoutMs 必须参与。
 */
export function journalKeyBase(prompt: string, opts: JournalKeyOpts): string {
  const tools =
    opts.tools == null
      ? null
      : [...opts.tools].map(String).sort()
  const material = canonical({
    prompt,
    agentType: opts.agentType ?? null,
    model: opts.model ?? null,
    schema: opts.schema ?? null,
    phase: opts.phase ?? null,
    tools,
    isolation: opts.isolation ?? null,
    timeoutMs: opts.timeoutMs ?? null
  })
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

export function journalKey(prompt: string, opts: JournalKeyOpts, occ: number): string {
  return journalKeyBase(prompt, opts) + ':' + occ
}

export type JournalEvent =
  | { t: 'agent'; key: string; result: unknown; pass: number }
  | { t: 'log'; msg: string; pass: number }
  | { t: 'phase'; title: string; pass: number }

export interface JournalLoad {
  results: Map<string, unknown>
  pass: number
}

/** runId 不得含路径分隔符，防止 journal 路径逃逸 */
const SAFE_RUN_ID = /^[0-9A-Za-z._-]+$/

function assertSafeRunId(runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new Error(`invalid workflow runId: ${JSON.stringify(runId)}`)
  }
  return runId
}

/**
 * 同步追加 journal（必须 sync：异步写会饿死 Node vm microtask 排空）。
 * 空 batch 为 no-op。
 */
export function appendJournalSync(
  workspaceRoot: string,
  runId: string,
  events: JournalEvent[]
): void {
  if (events.length === 0) return
  assertSafeRunId(runId)
  const path = runJournalPath(workspaceRoot, runId)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, events.map((e) => JSON.stringify(e) + '\n').join(''), 'utf-8')
}

/** 读取 journal；无法 parse 的行跳过（crash 残留容错） */
export function loadJournal(workspaceRoot: string, runId: string): JournalLoad {
  assertSafeRunId(runId)
  const path = runJournalPath(workspaceRoot, runId)
  if (!existsSync(path)) return { results: new Map(), pass: 1 }
  const text = readFileSync(path, 'utf-8')
  const results = new Map<string, unknown>()
  let maxPass = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    let ev: JournalEvent
    try {
      ev = JSON.parse(line) as JournalEvent
    } catch {
      continue
    }
    if (typeof ev.pass === 'number' && ev.pass > maxPass) maxPass = ev.pass
    if (ev.t === 'agent') results.set(ev.key, ev.result)
  }
  return { results, pass: maxPass + 1 }
}

/** script_sha 不匹配时清空 journal（写空文件，不 delete） */
export function clearJournal(workspaceRoot: string, runId: string): void {
  assertSafeRunId(runId)
  const path = runJournalPath(workspaceRoot, runId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '', 'utf-8')
}

export function scriptSha(script: string): string {
  return createHash('sha256').update(script).digest('hex')
}

/** 持久化 script_sha，供 resume 比对（原子写） */
export function writeScriptSha(workspaceRoot: string, runId: string, sha: string): void {
  assertSafeRunId(runId)
  const path = runJournalPath(workspaceRoot, runId).replace(/journal\.jsonl$/, 'script.sha')
  mkdirSync(dirname(path), { recursive: true })
  atomicWriteFileSync(path, sha)
}

export function readScriptSha(workspaceRoot: string, runId: string): string | null {
  assertSafeRunId(runId)
  const path = runJournalPath(workspaceRoot, runId).replace(/journal\.jsonl$/, 'script.sha')
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf-8').trim()
}

/**
 * 脚本源变化时的恢复策略。
 * - reject：拒绝 resume，调用方应报错（v2 默认）
 * - migrate：显式清空 journal 后允许继续（需调用方声明）
 * - clear（v1 兼容）：静默清空（仅非 v2 路径）
 */
export type ScriptShaMismatchPolicy = 'reject' | 'migrate' | 'clear'

export class ScriptShaMismatchError extends Error {
  readonly prevSha: string
  readonly nextSha: string
  readonly runId: string

  constructor(runId: string, prevSha: string, nextSha: string) {
    super(
      `workflow script source changed for run ${runId}; refuse silent resume ` +
        `(prev=${prevSha.slice(0, 8)}… next=${nextSha.slice(0, 8)}…). ` +
        `Pass scriptShaMismatch:'migrate' to clear journal and continue, or start a new run.`
    )
    this.name = 'ScriptShaMismatchError'
    this.runId = runId
    this.prevSha = prevSha
    this.nextSha = nextSha
  }
}

/**
 * resume 时处理 script_sha。
 * v2 默认 reject；显式 migrate 才清 journal。
 */
export function handleScriptShaOnResume(
  workspaceRoot: string,
  runId: string,
  nextSha: string,
  policy: ScriptShaMismatchPolicy = 'reject'
): { matched: boolean; cleared: boolean } {
  const prev = readScriptSha(workspaceRoot, runId)
  if (prev === null || prev === nextSha) {
    return { matched: true, cleared: false }
  }
  if (policy === 'reject') {
    throw new ScriptShaMismatchError(runId, prev, nextSha)
  }
  // migrate / clear：显式清空后继续
  clearJournal(workspaceRoot, runId)
  return { matched: false, cleared: true }
}
