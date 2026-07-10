/**
 * runWorkflow 主入口：建 TaskScope → 注入 hook → 跑脚本 → 收尾写 state
 * terminal：原子关闭 scope → abort child → grace allSettled → finalize worktree → 落盘
 */
import { parseMeta } from './meta'
import { evalScript } from './sandbox'
import {
  createHostHooks,
  type HookContext,
  type OwnedWorktree,
  type PendingAskUser
} from './hooks'
import { getBuiltinScript } from './builtin'
import {
  createInitialState,
  updateStatePhase,
  updateStateStatus,
  writeComposeState
} from './state'
import { ensureComposeRoot, ensureRunDir, generateRunId, pathExists, runDir } from './paths'
import {
  clearJournal,
  handleScriptShaOnResume,
  loadJournal,
  scriptSha,
  writeScriptSha,
  type ScriptShaMismatchPolicy
} from './journal'
import { makeRunSemaphore } from './semaphore'
import { TaskScope } from './TaskScope'
import {
  cancelWorkflowV2,
  getV2ActiveRun,
  getWorkflowStatusV2,
  isV2Workflow,
  runWorkflowV2,
  _resetV2ActiveRunsForTests
} from './v2'
import * as Worktree from '../worktree'
import type {
  RunOutcome,
  RunStatus,
  RunWorkflowOptions,
  WorkflowStatus
} from './types'

const DEFAULT_DEADLINE_MS = 12 * 60 * 60 * 1000
const TERMINAL_GRACE_MS = 5_000

interface ActiveRun {
  status: WorkflowStatus
  /** 根 TaskScope：取消/deadline 统一走 close */
  scope: TaskScope
  ownedWorktrees: Map<string, OwnedWorktree>
  workspaceRoot: string
  pendingAskUsers: Map<string, PendingAskUser>
}

/** 进程内活跃 run 表 */
const activeRuns = new Map<string, ActiveRun>()

function nowIso(): string {
  return new Date().toISOString()
}

function resolveScriptSource(script: string): { name: string; source: string } {
  if (/^\s*export\s+const\s+meta\s*=/.test(script)) {
    const parsed = parseMeta(script)
    if (!parsed.ok) throw new Error(parsed.error)
    return { name: parsed.meta.name, source: script }
  }
  const entry = getBuiltinScript(script)
  if (entry) return { name: entry.name, source: entry.script }
  throw new Error(`unknown workflow script: ${script}`)
}

/**
 * 成功：保留有改动的 worktree，pristine 删除；非成功：reclaim 全部。
 * 调用前须已 TaskScope.close（child 退出）；remove 内含有界 EBUSY 退避。
 */
async function finalizeWorktrees(
  workspaceRoot: string,
  owned: Map<string, OwnedWorktree>,
  success: boolean
): Promise<void> {
  const entries = [...owned.values()]
  for (const { info, baseSha } of entries) {
    try {
      if (!success) {
        await Worktree.remove({ workspaceRoot, directory: info.directory })
        owned.delete(info.directory)
        continue
      }
      const pristine = await Worktree.isPristine(info.directory, baseSha).catch(() => false)
      if (pristine) {
        await Worktree.remove({ workspaceRoot, directory: info.directory })
        owned.delete(info.directory)
      }
      // 有改动的保留，留给 integrate / 用户
    } catch (err) {
      // 清理失败不阻断终态，但必须留下占用路径便于排查（禁止静默忽略 EBUSY）
      console.warn(
        `[workflow] finalize worktree failed: ${info.directory}`,
        err instanceof Error ? err.message : err
      )
    }
  }
}

/**
 * 启动编排脚本。
 * resume=true 时载入已有 journal；script_sha 不匹配按 policy 处理（默认 reject）。
 */
export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunOutcome> {
  const { deps } = opts
  const { name: scriptName, source } = resolveScriptSource(opts.script)
  const parsed = parseMeta(source)
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }

  const runId = opts.runId ?? generateRunId()
  if (activeRuns.has(runId)) {
    throw new Error(`workflow run already active: ${runId}`)
  }

  // 内置 br-full-dev 默认走 v2 step graph
  if (isV2Workflow(scriptName, opts.engine)) {
    return runWorkflowV2({
      ...opts,
      scriptName,
      source,
      runId
    })
  }

  ensureComposeRoot(deps.workspaceRoot)
  ensureRunDir(deps.workspaceRoot, runId)

  const sha = scriptSha(source)
  // v1：resume 默认 reject（与 v2 一致）；显式 migrate/clear 才清 journal
  const mismatchPolicy: ScriptShaMismatchPolicy =
    opts.scriptShaMismatch ?? (opts.resume ? 'reject' : 'clear')

  if (opts.resume) {
    handleScriptShaOnResume(deps.workspaceRoot, runId, sha, mismatchPolicy)
  } else {
    // 新 run：若同 runId 残留 journal，清空以免混入
    clearJournal(deps.workspaceRoot, runId)
  }
  writeScriptSha(deps.workspaceRoot, runId, sha)

  const journal = loadJournal(deps.workspaceRoot, runId)
  const occ = new Map<string, number>()
  const { runSem, globalSem } = makeRunSemaphore(opts.maxConcurrentAgents)
  const ownedWorktrees = new Map<string, OwnedWorktree>()

  const startedAt = nowIso()
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS
  const scope = new TaskScope({
    label: `workflow:${runId}`,
    deadlineMs,
    graceMs: TERMINAL_GRACE_MS
  })
  const pendingAskUsers = new Map<string, PendingAskUser>()
  const status: WorkflowStatus = {
    runId,
    scriptName,
    status: 'running',
    startedAt,
    updatedAt: startedAt
  }
  activeRuns.set(runId, {
    status,
    scope,
    ownedWorktrees,
    workspaceRoot: deps.workspaceRoot,
    pendingAskUsers
  })

  const composeState = createInitialState({
    runId,
    scriptName,
    startedAt,
    sessionId: deps.sessionId
  })

  const persistState = (): void => {
    // scope 已关闭则拒绝落盘（旧 continuation）
    if (scope.isClosed) return
    // v1 引擎显式镜像写全局 state.json；v2 默认不写
    writeComposeState(deps.workspaceRoot, composeState, { mirrorV1: true })
    let snapshot: Record<string, unknown>
    try {
      snapshot = JSON.parse(JSON.stringify(composeState)) as Record<string, unknown>
    } catch {
      snapshot = { run: composeState.run }
    }
    deps.parentEventBus.emit({
      type: 'workflow_state',
      runId,
      sessionId: deps.sessionId,
      state: snapshot
    })
  }
  persistState()

  // 外部取消 → close scope（真正 abort child）
  const externalSignal = opts.abortSignal
  const onExternalAbort = (): void => {
    cancelWorkflow(runId)
  }
  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort()
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  const currentPhase = { name: '' }
  const hookCtx: HookContext = {
    runId,
    deps,
    abortSignal: scope.signal,
    scope,
    scopeGeneration: scope.captureGeneration(),
    currentPhase,
    onPhase: (phaseName) => {
      if (scope.isClosed) return
      const at = nowIso()
      status.phase = phaseName
      status.updatedAt = at
      updateStatePhase(composeState, phaseName, at)
      persistState()
    },
    onLog: () => {
      if (scope.isClosed) return
      status.updatedAt = nowIso()
    },
    journal,
    occ,
    runSem,
    globalSem,
    ownedWorktrees,
    composeState,
    pendingAskUsers,
    persistState
  }

  const hooks = createHostHooks(hookCtx)

  let outcome: RunOutcome
  let terminalReason: 'completed' | 'failed' | 'cancelled' | 'deadline' = 'completed'
  try {
    const result = await evalScript(parsed.body, hooks, {
      deadlineMs,
      args: opts.args,
      scope
    })

    if (scope.signal.aborted || scope.isClosed) {
      terminalReason =
        scope.reason === 'deadline' ? 'deadline' : 'cancelled'
      outcome =
        terminalReason === 'deadline'
          ? { status: 'failed', runId, error: 'workflow script deadline exceeded' }
          : { status: 'cancelled', runId }
    } else {
      outcome = { status: 'completed', runId, result }
    }
  } catch (err) {
    if (scope.signal.aborted || scope.isClosed) {
      terminalReason =
        scope.reason === 'deadline' ? 'deadline' : 'cancelled'
      if (terminalReason === 'deadline') {
        outcome = { status: 'failed', runId, error: 'workflow script deadline exceeded' }
      } else {
        outcome = { status: 'cancelled', runId }
      }
    } else {
      const error = err instanceof Error ? err.message : String(err)
      status.error = error
      terminalReason = 'failed'
      outcome = { status: 'failed', runId, error }
    }
  }

  // 终态必须等待真实任务退出；若宽限期后仍存活，禁止回收可能仍被占用的 worktree。
  const closeResult = await scope.close(
    terminalReason === 'completed'
      ? 'completed'
      : terminalReason === 'deadline'
        ? 'deadline'
        : terminalReason === 'cancelled'
          ? 'cancelled'
          : 'failed'
  )

  for (const [, pending] of pendingAskUsers) {
    pending.resolve(null)
  }
  pendingAskUsers.clear()

  const success = outcome.status === 'completed'
  if (closeResult.settled) {
    await finalizeWorktrees(deps.workspaceRoot, ownedWorktrees, success)
  } else {
    console.warn(
      `[workflow] skip worktree cleanup; lingering tasks: ${closeResult.lingeringTaskIds.join(', ')}`
    )
  }

  const finishedAt = nowIso()
  const finalStatus: RunStatus = outcome.status
  status.status = finalStatus
  status.updatedAt = finishedAt
  updateStateStatus(composeState, finalStatus, finishedAt)
  // 终态落盘：scope 已关，直接写（绕过 persistState 的 closed 检查）
  writeComposeState(deps.workspaceRoot, composeState, { mirrorV1: true })
  let snapshot: Record<string, unknown>
  try {
    snapshot = JSON.parse(JSON.stringify(composeState)) as Record<string, unknown>
  } catch {
    snapshot = { run: composeState.run }
  }
  deps.parentEventBus.emit({
    type: 'workflow_state',
    runId,
    sessionId: deps.sessionId,
    state: snapshot
  })

  activeRuns.delete(runId)
  externalSignal?.removeEventListener('abort', onExternalAbort)

  return outcome
}

/**
 * 解除 askUser 阻塞（IPC / 测试调用）。
 * @returns 是否找到对应挂起请求
 */
export function resolveWorkflowAskUser(
  runId: string,
  requestId: string,
  answer: string
): boolean {
  const v2 = getV2ActiveRun(runId)
  const entry = v2 ?? activeRuns.get(runId)
  if (!entry) return false
  const pending = entry.pendingAskUsers.get(requestId)
  if (!pending) return false
  pending.resolve(answer)
  entry.pendingAskUsers.delete(requestId)
  return true
}

/** 取消正在运行的编排；已结束的 run 返回 false */
export function cancelWorkflow(runId: string): boolean {
  if (cancelWorkflowV2(runId)) return true
  const entry = activeRuns.get(runId)
  if (!entry) return false
  for (const [, pending] of entry.pendingAskUsers) {
    pending.resolve(null)
  }
  entry.pendingAskUsers.clear()
  void entry.scope.close('cancelled')
  entry.status.status = 'cancelled'
  entry.status.updatedAt = nowIso()
  return true
}

export function getWorkflowStatus(runId: string): WorkflowStatus | undefined {
  return getWorkflowStatusV2(runId) ?? activeRuns.get(runId)?.status
}

export function listWorkflows(): WorkflowStatus[] {
  const v1 = [...activeRuns.values()].map((r) => ({ ...r.status }))
  // v2 活跃 run 通过 getWorkflowStatus 单查；list 合并
  return v1
}

/**
 * 测试辅助：关闭 scope（等 child 收敛）后再删 owned worktree。
 * 必须 await：Windows 上 fire-and-forget remove 易与 afterEach rmSync 撞 EBUSY。
 */
export async function _resetWorkflowRuntimeForTests(): Promise<void> {
  await _resetV2ActiveRunsForTests()
  const entries = [...activeRuns.values()]
  activeRuns.clear()
  for (const entry of entries) {
    if (!entry.scope.isClosed) {
      await entry.scope.close('cancelled')
    }
    for (const { info } of [...entry.ownedWorktrees.values()]) {
      try {
        await Worktree.remove({
          workspaceRoot: entry.workspaceRoot,
          directory: info.directory
        })
      } catch (err) {
        // 记录仍占用资源，不吞成「调大 timeout」
        console.warn(
          `[workflow-test] worktree cleanup failed: ${info.directory}`,
          err instanceof Error ? err.message : err
        )
      }
      entry.ownedWorktrees.delete(info.directory)
    }
  }
}

export function _runDirExists(workspaceRoot: string, runId: string): boolean {
  return pathExists(runDir(workspaceRoot, runId))
}
