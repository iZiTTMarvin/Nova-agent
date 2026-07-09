/**
 * 编排进度面板用的 state 视图类型（与 `.nova/compose/state.json` 对齐）
 */

export type ComposeRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export type ComposeTaskStatus = 'pending' | 'in_progress' | 'done' | 'skipped' | 'failed'

export type ComposeFailureReason =
  | 'verify_failed_3x'
  | 'debug_unresolved'
  | 'dependency_missing'
  | 'test_timeout'
  | 'user_aborted'
  | 'agent_failed'

export interface ComposeTaskFailure {
  reason: ComposeFailureReason | string
  summary: string
  evidence?: string
  root_cause_guess?: string
  tried?: string[]
  next_steps?: string[]
}

export interface ComposeTaskView {
  id: string
  title: string
  status: ComposeTaskStatus | string
  size?: string
  attempts?: number
  verify?: { pass: number; fail: number; evidence?: string }
  failure?: ComposeTaskFailure
  started_at?: string
  finished_at?: string
}

export interface ComposeStateView {
  run: {
    id: string
    command: string
    script: string
    started_at: string
    updated_at: string
    status: ComposeRunStatus | string
    /** 发起编排的会话 id；门控与磁盘过滤用 */
    session_id?: string
  }
  phase?: {
    current: string
    label: string
    entered_at: string
  }
  artifacts?: {
    spec?: string
    plan?: string
    report?: string
    [key: string]: string | undefined
  }
  tasks?: ComposeTaskView[]
  global_check?: {
    test?: { status: string; evidence?: string }
    build?: { status: string; evidence?: string }
    lint?: { status: string; evidence?: string }
  }
  auto_decisions?: Array<{
    phase: string
    decision: string
    reason: string
    auto: boolean
  }>
  review?: {
    verdict: string
    critical_count: number
    high_count: number
    issues: unknown[]
  }
  stats?: {
    total: number
    done: number
    skipped: number
    failed: number
  }
}

export interface PendingComposeAskUser {
  runId: string
  requestId: string
  question: string
  options: string[]
}

/** 从 IPC 原始对象安全解析为视图类型 */
export function parseComposeStateView(raw: unknown): ComposeStateView | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const run = o.run
  if (!run || typeof run !== 'object') return null
  const r = run as Record<string, unknown>
  if (typeof r.id !== 'string') return null
  return raw as ComposeStateView
}
