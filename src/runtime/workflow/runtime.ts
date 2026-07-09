/**
 * runWorkflow 主入口：建沙箱 → 注入 hook → 跑脚本 → 收尾写 state
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
  loadJournal,
  readScriptSha,
  scriptSha,
  writeScriptSha
} from './journal'
import { makeRunSemaphore } from './semaphore'
import * as Worktree from '../worktree'
import type {
  RunOutcome,
  RunStatus,
  RunWorkflowOptions,
  WorkflowStatus
} from './types'

const DEFAULT_DEADLINE_MS = 12 * 60 * 60 * 1000

interface ActiveRun {
  status: WorkflowStatus
  abort: AbortController
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

/** 成功：保留有改动的 worktree，pristine 删除；非成功：reclaim 全部 */
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
    } catch {
      /* 清理失败不阻断终态 */
    }
  }
}

/**
 * 启动编排脚本。
 * resume=true 时载入已有 journal；script_sha 不匹配则清空 journal。
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

  ensureComposeRoot(deps.workspaceRoot)
  ensureRunDir(deps.workspaceRoot, runId)

  // script_sha：resume 时比对，不匹配则 freshJournal
  const sha = scriptSha(source)
  if (opts.resume) {
    const prev = readScriptSha(deps.workspaceRoot, runId)
    if (prev !== null && prev !== sha) {
      clearJournal(deps.workspaceRoot, runId)
    }
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
  const abort = new AbortController()
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
    abort,
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
    writeComposeState(deps.workspaceRoot, composeState)
    // 进度面板全量同步（JSON 拷贝，保证纯数据边界）
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

  // 外部取消信号（停止按钮 → AgentLoop.cancel → 这里）：
  // 等价于 cancelWorkflow(runId)，保证「一次停止」能穿透整个编排链路。
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
    abortSignal: abort.signal,
    currentPhase,
    onPhase: (phaseName) => {
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
    persistState
  }

  const hooks = createHostHooks(hookCtx)

  let outcome: RunOutcome
  try {
    const result = await evalScript(parsed.body, hooks, {
      deadlineMs: opts.deadlineMs ?? DEFAULT_DEADLINE_MS,
      args: opts.args
    })

    if (abort.signal.aborted) {
      outcome = { status: 'cancelled', runId }
    } else {
      outcome = { status: 'completed', runId, result }
    }
  } catch (err) {
    if (abort.signal.aborted) {
      outcome = { status: 'cancelled', runId }
    } else {
      const error = err instanceof Error ? err.message : String(err)
      status.error = error
      outcome = { status: 'failed', runId, error }
    }
  }

  // 终态：解除所有挂起的 askUser，避免 Promise 泄漏
  for (const [, pending] of pendingAskUsers) {
    pending.resolve(null)
  }
  pendingAskUsers.clear()

  const success = outcome.status === 'completed'
  await finalizeWorktrees(deps.workspaceRoot, ownedWorktrees, success)

  const finishedAt = nowIso()
  const finalStatus: RunStatus = outcome.status
  status.status = finalStatus
  status.updatedAt = finishedAt
  updateStateStatus(composeState, finalStatus, finishedAt)
  persistState()
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
  const entry = activeRuns.get(runId)
  if (!entry) return false
  const pending = entry.pendingAskUsers.get(requestId)
  if (!pending) return false
  pending.resolve(answer)
  entry.pendingAskUsers.delete(requestId)
  return true
}

/** 取消正在运行的编排；已结束的 run 返回 false */
export function cancelWorkflow(runId: string): boolean {
  const entry = activeRuns.get(runId)
  if (!entry) return false
  // 先解除 askUser，再 abort，避免脚本卡在 Promise
  for (const [, pending] of entry.pendingAskUsers) {
    pending.resolve(null)
  }
  entry.pendingAskUsers.clear()
  entry.abort.abort()
  entry.status.status = 'cancelled'
  entry.status.updatedAt = nowIso()
  return true
}

export function getWorkflowStatus(runId: string): WorkflowStatus | undefined {
  return activeRuns.get(runId)?.status
}

export function listWorkflows(): WorkflowStatus[] {
  return [...activeRuns.values()].map((r) => ({ ...r.status }))
}

/** 测试辅助：清空活跃表并 reclaim worktree */
export function _resetWorkflowRuntimeForTests(): void {
  for (const entry of activeRuns.values()) {
    entry.abort.abort()
    for (const { info } of entry.ownedWorktrees.values()) {
      void Worktree.remove({
        workspaceRoot: entry.workspaceRoot,
        directory: info.directory
      }).catch(() => undefined)
    }
  }
  activeRuns.clear()
}

export function _runDirExists(workspaceRoot: string, runId: string): boolean {
  return pathExists(runDir(workspaceRoot, runId))
}
