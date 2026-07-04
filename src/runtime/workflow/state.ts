/**
 * `.nova/compose/state.json` 读写与增量更新。
 * 脚本通过 updateState host hook 调用本模块；runtime 在 phase/终态时也会写。
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type {
  ComposeAutoDecision,
  ComposeCheckResult,
  ComposePhaseKey,
  ComposeReview,
  ComposeState,
  ComposeStats,
  ComposeTask,
  ComposeTaskFailure,
  RunStatus
} from './types'
import { ensureComposeRoot, statePath } from './paths'

/** 中文 phase 标题 / 英文键 → state.phase */
const PHASE_META: Record<string, { current: ComposePhaseKey; label: string }> = {
  探索: { current: 'explore', label: '阶段 1：探索' },
  explore: { current: 'explore', label: '阶段 1：探索' },
  计划: { current: 'plan', label: '阶段 2：计划' },
  plan: { current: 'plan', label: '阶段 2：计划' },
  执行: { current: 'execute', label: '阶段 3：执行' },
  execute: { current: 'execute', label: '阶段 3：执行' },
  审查: { current: 'review', label: '阶段 4：审查' },
  review: { current: 'review', label: '阶段 4：审查' },
  发布: { current: 'ship', label: '阶段 5：发布' },
  ship: { current: 'ship', label: '阶段 5：发布' }
}

export function readComposeState(workspaceRoot: string): ComposeState | null {
  const p = statePath(workspaceRoot)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as ComposeState
  } catch {
    return null
  }
}

export function writeComposeState(workspaceRoot: string, state: ComposeState): void {
  ensureComposeRoot(workspaceRoot)
  writeFileSync(statePath(workspaceRoot), JSON.stringify(state, null, 2), 'utf-8')
}

export function createInitialState(opts: {
  runId: string
  scriptName: string
  startedAt: string
}): ComposeState {
  return {
    run: {
      id: opts.runId,
      command: opts.scriptName,
      script: opts.scriptName,
      started_at: opts.startedAt,
      updated_at: opts.startedAt,
      status: 'running'
    },
    tasks: [],
    auto_decisions: [],
    stats: { total: 0, done: 0, skipped: 0, failed: 0 }
  }
}

export function resolvePhaseMeta(phaseName: string): { current: string; label: string } {
  const hit = PHASE_META[phaseName]
  if (hit) return hit
  return { current: phaseName, label: phaseName }
}

export function updateStatePhase(state: ComposeState, phaseName: string, at: string): void {
  const meta = resolvePhaseMeta(phaseName)
  state.phase = {
    current: meta.current,
    label: meta.label,
    entered_at: at
  }
  state.run.updated_at = at
}

export function updateStateStatus(state: ComposeState, status: RunStatus, at: string): void {
  state.run.status = status
  state.run.updated_at = at
}

/** 从 tasks[] 重算 stats */
export function recomputeStats(tasks: ComposeTask[] | undefined): ComposeStats {
  const list = tasks ?? []
  return {
    total: list.length,
    done: list.filter((t) => t.status === 'done').length,
    skipped: list.filter((t) => t.status === 'skipped').length,
    failed: list.filter((t) => t.status === 'failed').length
  }
}

function touch(state: ComposeState, at?: string): void {
  state.run.updated_at = at ?? new Date().toISOString()
}

/** 合并 artifacts 指针 */
export function setArtifacts(
  state: ComposeState,
  artifacts: Partial<NonNullable<ComposeState['artifacts']>>,
  at?: string
): void {
  state.artifacts = { ...(state.artifacts ?? {}), ...artifacts }
  touch(state, at)
}

/** 整体替换任务列表（计划阶段写入） */
export function setTasks(state: ComposeState, tasks: ComposeTask[], at?: string): void {
  state.tasks = tasks
  state.stats = recomputeStats(tasks)
  touch(state, at)
}

/** 按 id 合并更新单个任务 */
export function updateTask(
  state: ComposeState,
  taskId: string,
  patch: Partial<ComposeTask>,
  at?: string
): void {
  if (!state.tasks) state.tasks = []
  const idx = state.tasks.findIndex((t) => t.id === taskId)
  if (idx < 0) {
    state.tasks.push({ id: taskId, title: patch.title ?? taskId, status: 'pending', ...patch })
  } else {
    state.tasks[idx] = { ...state.tasks[idx]!, ...patch, id: taskId }
  }
  state.stats = recomputeStats(state.tasks)
  touch(state, at)
}

/** 标记任务 skipped/failed 并写入 failure 诊断 */
export function writeTaskFailure(
  state: ComposeState,
  taskId: string,
  failure: ComposeTaskFailure,
  opts?: { status?: 'skipped' | 'failed'; attempts?: number; at?: string }
): void {
  const at = opts?.at ?? new Date().toISOString()
  updateTask(
    state,
    taskId,
    {
      status: opts?.status ?? 'skipped',
      failure,
      attempts: opts?.attempts,
      finished_at: at
    },
    at
  )
}

export function setReview(state: ComposeState, review: ComposeReview, at?: string): void {
  state.review = review
  touch(state, at)
}

export function setGlobalCheck(
  state: ComposeState,
  check: Partial<NonNullable<ComposeState['global_check']>>,
  at?: string
): void {
  state.global_check = { ...(state.global_check ?? {}), ...check }
  touch(state, at)
}

export function appendAutoDecision(
  state: ComposeState,
  decision: ComposeAutoDecision,
  at?: string
): void {
  if (!state.auto_decisions) state.auto_decisions = []
  state.auto_decisions.push(decision)
  touch(state, at)
}

/**
 * 脚本侧 updateState(patch) 的浅合并入口。
 * 支持顶层字段；tasks 若传入则整体替换；stats 自动重算。
 */
export function applyStatePatch(
  state: ComposeState,
  patch: Record<string, unknown>,
  at?: string
): void {
  if (patch.artifacts && typeof patch.artifacts === 'object') {
    setArtifacts(state, patch.artifacts as Partial<NonNullable<ComposeState['artifacts']>>, at)
  }
  if (Array.isArray(patch.tasks)) {
    setTasks(state, patch.tasks as ComposeTask[], at)
  }
  if (patch.review && typeof patch.review === 'object') {
    setReview(state, patch.review as ComposeReview, at)
  }
  if (patch.global_check && typeof patch.global_check === 'object') {
    setGlobalCheck(
      state,
      patch.global_check as Partial<NonNullable<ComposeState['global_check']>>,
      at
    )
  }
  if (patch.auto_decisions && Array.isArray(patch.auto_decisions)) {
    // 追加而非替换，避免脚本误覆盖历史决策
    for (const d of patch.auto_decisions as ComposeAutoDecision[]) {
      appendAutoDecision(state, d, at)
    }
  }
  // 单任务增量：{ task: { id, ...patch } }
  if (patch.task && typeof patch.task === 'object') {
    const t = patch.task as Partial<ComposeTask> & { id: string }
    if (t.id) updateTask(state, t.id, t, at)
  }
  // 失败写入：{ failure: { taskId, ...failure fields } }
  if (patch.failure && typeof patch.failure === 'object') {
    const f = patch.failure as ComposeTaskFailure & {
      taskId: string
      status?: 'skipped' | 'failed'
      attempts?: number
    }
    if (f.taskId) {
      const { taskId, status, attempts, ...failure } = f
      writeTaskFailure(state, taskId, failure, { status, attempts, at })
    }
  }
  if (patch.phase && typeof patch.phase === 'object') {
    const p = patch.phase as { current?: string; label?: string; entered_at?: string }
    if (p.current) {
      state.phase = {
        current: p.current,
        label: p.label ?? resolvePhaseMeta(p.current).label,
        entered_at: p.entered_at ?? at ?? new Date().toISOString()
      }
    }
  }
  touch(state, at)
  if (state.tasks) state.stats = recomputeStats(state.tasks)
}

/** 便捷：写一条 global_check 项 */
export function setCheckItem(
  state: ComposeState,
  kind: 'test' | 'build' | 'lint',
  result: ComposeCheckResult,
  at?: string
): void {
  setGlobalCheck(state, { [kind]: result }, at)
}
