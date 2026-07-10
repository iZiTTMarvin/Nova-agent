/**
 * Workflow v2 入口：TaskScope + StepEngine + br-full-dev
 */
import { createHostHooks, type OwnedWorktree, type PendingAskUser } from '../hooks'
import { getBuiltinScript } from '../builtin'
import { scriptSha, loadJournal } from '../journal'
import {
  createInitialState,
  updateStatePhase,
  updateStateStatus,
  writeComposeState
} from '../state'
import { ensureComposeRoot, ensureRunDir } from '../paths'
import { makeRunSemaphore } from '../semaphore'
import { TaskScope } from '../TaskScope'
import { StepEngine, buildResumePlanFromDisk } from './StepEngine'
import { runBrFullDevV2 } from './brFullDev'
import { readManifest } from './stepStore'
import type { ResumePlan } from './types'
import type { RunOutcome, RunWorkflowOptions, WorkflowStatus } from '../types'
import * as Worktree from '../../worktree'

const TERMINAL_GRACE_MS = 5_000

function nowIso(): string {
  return new Date().toISOString()
}

export function isV2Workflow(scriptName: string, engine?: 'v1' | 'v2'): boolean {
  if (engine === 'v1') return false
  if (engine === 'v2') return true
  return scriptName === 'br-full-dev'
}

export interface V2ActiveHandle {
  status: WorkflowStatus
  scope: TaskScope
  ownedWorktrees: Map<string, OwnedWorktree>
  workspaceRoot: string
  pendingAskUsers: Map<string, PendingAskUser>
}

/** 供 runtime.cancelWorkflow 共用 */
const v2ActiveRuns = new Map<string, V2ActiveHandle>()

export function getV2ActiveRun(runId: string): V2ActiveHandle | undefined {
  return v2ActiveRuns.get(runId)
}

export async function runWorkflowV2(
  opts: RunWorkflowOptions & {
    scriptName: string
    source: string
    runId: string
  }
): Promise<RunOutcome> {
  const { deps, scriptName, source, runId } = opts
  ensureComposeRoot(deps.workspaceRoot)
  ensureRunDir(deps.workspaceRoot, runId)

  const sha = scriptSha(source)
  const deadlineMs = opts.deadlineMs ?? 12 * 60 * 60 * 1000
  const scope = new TaskScope({
    label: `workflow-v2:${runId}`,
    deadlineMs,
    graceMs: TERMINAL_GRACE_MS
  })

  const startedAt = nowIso()
  const composeState = createInitialState({
    runId,
    scriptName,
    startedAt,
    sessionId: deps.sessionId
  })

  const ownedWorktrees = new Map<string, OwnedWorktree>()
  const pendingAskUsers = new Map<string, PendingAskUser>()
  const status: WorkflowStatus = {
    runId,
    scriptName,
    status: 'running',
    startedAt,
    updatedAt: startedAt
  }
  v2ActiveRuns.set(runId, {
    status,
    scope,
    ownedWorktrees,
    workspaceRoot: deps.workspaceRoot,
    pendingAskUsers
  })

  const { runSem, globalSem } = makeRunSemaphore(opts.maxConcurrentAgents)
  const journal = loadJournal(deps.workspaceRoot, runId)
  const occ = new Map<string, number>()
  const currentPhase = { name: '' }

  const persistState = (): void => {
    if (scope.isClosed) return
    // v2：只写 runs/<runId>/state.json，不再镜像 v1 全局 state.json
    writeComposeState(deps.workspaceRoot, composeState)
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

  const hookCtx = {
    runId,
    deps,
    abortSignal: scope.signal,
    scope,
    scopeGeneration: scope.captureGeneration(),
    currentPhase,
    onPhase: (phaseName: string) => {
      if (scope.isClosed) return
      const at = nowIso()
      status.phase = phaseName
      status.updatedAt = at
      updateStatePhase(composeState, phaseName, at)
      persistState()
    },
    onLog: () => {
      status.updatedAt = nowIso()
    },
    journal,
    occ,
    runSem,
    globalSem,
    ownedWorktrees,
    composeState,
    pendingAskUsers,
    persistState,
    ...(opts.assertExecutionCurrent
      ? { assertExecutionCurrent: opts.assertExecutionCurrent }
      : {})
  }

  const hooks = createHostHooks(hookCtx)

  let engine: StepEngine
  try {
    engine = new StepEngine({
      workspaceRoot: deps.workspaceRoot,
      runId,
      workflowName: scriptName,
      scriptSha: sha,
      scope,
      rerunFromStepId: opts.rerunFromStepId,
      onScriptShaMismatch: opts.scriptShaMismatch === 'migrate' ? 'migrate' : 'reject'
    })
  } catch (err) {
    await scope.close('failed')
    v2ActiveRuns.delete(runId)
    const error = err instanceof Error ? err.message : String(err)
    updateStateStatus(composeState, 'failed', nowIso())
    writeComposeState(deps.workspaceRoot, composeState)
    return { status: 'failed', runId, error }
  }

  const externalSignal = opts.abortSignal
  const onExternalAbort = (): void => {
    for (const [, pending] of pendingAskUsers) pending.resolve(null)
    pendingAskUsers.clear()
    void scope.close('cancelled')
    status.status = 'cancelled'
    status.updatedAt = nowIso()
  }
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  let outcome: RunOutcome
  try {
    if (scriptName !== 'br-full-dev') {
      throw new Error(`workflow v2 does not yet support script: ${scriptName}`)
    }
    const requirement =
      typeof opts.args === 'object' && opts.args && 'requirement' in (opts.args as object)
        ? String((opts.args as { requirement?: string }).requirement ?? '')
        : typeof opts.args === 'string'
          ? opts.args
          : ''

    const result = await runBrFullDevV2({
      engine,
      hooks,
      hookCtx,
      deps,
      scope,
      composeState,
      persistState,
      requirement
    })

    if (scope.signal.aborted || scope.isClosed) {
      outcome =
        scope.reason === 'deadline'
          ? { status: 'failed', runId, error: 'workflow script deadline exceeded' }
          : { status: 'cancelled', runId }
    } else if (result && typeof result === 'object' && 'error' in (result as object)) {
      const error = String((result as { error: string }).error)
      outcome = { status: 'failed', runId, error }
    } else {
      outcome = { status: 'completed', runId, result }
    }
  } catch (err) {
    if (scope.signal.aborted || scope.isClosed) {
      outcome =
        scope.reason === 'deadline'
          ? { status: 'failed', runId, error: 'workflow script deadline exceeded' }
          : { status: 'cancelled', runId }
    } else {
      const error = err instanceof Error ? err.message : String(err)
      outcome = { status: 'failed', runId, error }
    }
  }

  const closeResult = await scope.close(
    outcome.status === 'completed'
      ? 'completed'
      : outcome.status === 'cancelled'
        ? 'cancelled'
        : 'failed'
  )

  for (const [, pending] of pendingAskUsers) pending.resolve(null)
  pendingAskUsers.clear()

  // 只有真实任务已收敛，才可删除可能仍被子进程占用的 worktree。
  const success = outcome.status === 'completed'
  if (!closeResult.settled) {
    console.warn(
      `[workflow-v2] skip worktree cleanup; lingering tasks: ${closeResult.lingeringTaskIds.join(', ')}`
    )
  }
  for (const { info, baseSha } of closeResult.settled ? [...ownedWorktrees.values()] : []) {
    try {
      if (!success) {
        await Worktree.remove({ workspaceRoot: deps.workspaceRoot, directory: info.directory })
      } else {
        const pristine = await Worktree.isPristine(info.directory, baseSha).catch(() => false)
        if (pristine) {
          await Worktree.remove({ workspaceRoot: deps.workspaceRoot, directory: info.directory })
        }
      }
      ownedWorktrees.delete(info.directory)
    } catch (err) {
      console.warn(
        `[workflow-v2] finalize worktree failed: ${info.directory}`,
        err instanceof Error ? err.message : err
      )
    }
  }

  const finishedAt = nowIso()
  status.status = outcome.status
  status.updatedAt = finishedAt
  updateStateStatus(composeState, outcome.status, finishedAt)
  writeComposeState(deps.workspaceRoot, composeState)
  deps.parentEventBus.emit({
    type: 'workflow_state',
    runId,
    sessionId: deps.sessionId,
    state: JSON.parse(JSON.stringify(composeState)) as Record<string, unknown>
  })

  v2ActiveRuns.delete(runId)
  externalSignal?.removeEventListener('abort', onExternalAbort)
  return outcome
}

export function cancelWorkflowV2(runId: string): boolean {
  const entry = v2ActiveRuns.get(runId)
  if (!entry) return false
  for (const [, pending] of entry.pendingAskUsers) pending.resolve(null)
  entry.pendingAskUsers.clear()
  void entry.scope.close('cancelled')
  entry.status.status = 'cancelled'
  entry.status.updatedAt = nowIso()
  return true
}

export function getWorkflowStatusV2(runId: string): WorkflowStatus | undefined {
  return v2ActiveRuns.get(runId)?.status
}

export function inspectComposeResume(
  workspaceRoot: string,
  runId: string,
  rerunFromStepId?: string
): ResumePlan | null {
  return buildResumePlanFromDisk(workspaceRoot, runId, rerunFromStepId)
}

export function getComposeV2Manifest(workspaceRoot: string, runId: string) {
  return readManifest(workspaceRoot, runId)
}

export function resolveBuiltinSource(name: string): string | null {
  return getBuiltinScript(name)?.script ?? null
}

/** 测试辅助：先关 scope（等 child），再清表；与 v1 reset 一样必须 await */
export async function _resetV2ActiveRunsForTests(): Promise<void> {
  const entries = [...v2ActiveRuns.values()]
  v2ActiveRuns.clear()
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
        console.warn(
          `[workflow-v2-test] worktree cleanup failed: ${info.directory}`,
          err instanceof Error ? err.message : err
        )
      }
      entry.ownedWorktrees.delete(info.directory)
    }
  }
}

export { buildResumePlanFromDisk } from './StepEngine'
