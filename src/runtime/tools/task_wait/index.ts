import {
  deriveSubagentNotificationId,
  isTerminalRunStatus,
  type RunStatus
} from '../../../shared/run/types'
import type { RunCoordinator } from '../../run'
import type { SessionData, SessionStore } from '../../sessions'
import { isSubagentNotificationEligible, projectSubagentExecutionResult } from '../../subagents'
import type { ToolContext, ToolExecutor, ToolResult } from '../types'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 60_000

/** task_wait 依赖 RunCoordinator 的窄读接口：取快照、枚举派遣、订阅状态变更。 */
export interface TaskWaitToolDeps {
  readonly getRunCoordinator: () => Pick<RunCoordinator, 'getSnapshot' | 'listDispatchSnapshots' | 'subscribe'>
}

export interface TaskWaitTarget {
  readonly runId: string
  readonly childSessionId: string
  readonly status: RunStatus
  readonly waitingUser: boolean
  readonly notificationId?: string
  readonly summary?: string
  readonly incompleteReason?: string
}

export interface TaskWaitResult {
  readonly ok: true
  readonly reason: 'ready' | 'timeout' | 'empty'
  readonly targets: readonly TaskWaitTarget[]
}

function failure(error: string): ToolResult {
  return { success: false, output: '', error }
}

function jsonResult(payload: TaskWaitResult): ToolResult {
  // 从 payload.targets 提取有资格的 notificationId，去重后作为持久消费事实。
  // 不从 output JSON 反解；失败/empty/waiting_user/无资格终态均无字段。
  const subagentNotificationIds = [...new Set(
    payload.targets.flatMap(target => target.notificationId ? [target.notificationId] : [])
  )]
  return {
    success: true,
    output: JSON.stringify(payload),
    ...(subagentNotificationIds.length > 0 ? { subagentNotificationIds } : {})
  }
}

/** 严格校验 timeout_ms：缺省用默认；存在则必须是 0..60000 的有限整数，否则失败。 */
function validateTimeoutMs(value: unknown): number | { error: string } {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { error: 'timeout_ms 必须是 0..60000 的整数' }
  }
  if (value < 0 || value > MAX_TIMEOUT_MS) {
    return { error: 'timeout_ms 必须是 0..60000 的整数' }
  }
  return value
}

/** 沿当前 run 的 dispatch.parentRunId 链向上枚举祖先 runId，含自身。 */
function collectAncestorRunIds(
  coordinator: Pick<RunCoordinator, 'getSnapshot'>,
  startRunId: string
): Set<string> {
  const ancestors = new Set<string>()
  let current: string | undefined = startRunId
  const seen = new Set<string>()
  while (current) {
    if (seen.has(current)) break
    seen.add(current)
    ancestors.add(current)
    const snap = coordinator.getSnapshot(current)
    current = snap?.dispatch?.parentRunId
  }
  return ancestors
}

/** 判断 candidate session 是否是 current session 的后代（沿 lineage.parentSessionId 上溯）。 */
function isDescendantSession(
  store: SessionStore,
  candidate: SessionData,
  ancestorSessionId: string
): boolean {
  let current: SessionData | null = candidate
  const seen = new Set<string>()
  while (current?.kind === 'subagent') {
    if (seen.has(current.id)) return false
    seen.add(current.id)
    const parentId = current.subagent.lineage.parentSessionId
    if (parentId === ancestorSessionId) return true
    current = store.load(parentId)
  }
  return false
}

/**
 * 投影单个冻结目标的当前状态。
 * waitingUser：status===waiting_user 或有 pending/submitting 交互都视为等待用户。
 * notificationId：仅当与投递分类的「通知资格」一致时生成，复用 isSubagentNotificationEligible。
 */
function projectTarget(
  coordinator: Pick<RunCoordinator, 'getSnapshot'>,
  store: SessionStore,
  runId: string
): TaskWaitTarget | null {
  const snap = coordinator.getSnapshot(runId)
  if (!snap?.dispatch) return null
  const hasPendingInteraction = snap.pendingInteractions.some(
    i => i.status === 'pending' || i.status === 'submitting'
  )
  const waitingUser = snap.status === 'waiting_user' || hasPendingInteraction
  // 等待用户时对外统一报 waiting_user，使 isReady 与用户可见状态一致。
  const status: RunStatus = waitingUser ? 'waiting_user' : snap.status
  const childSession = store.load(snap.sessionId)
  if (!childSession || childSession.kind !== 'subagent') {
    return {
      runId,
      childSessionId: snap.sessionId,
      status,
      waitingUser
    }
  }
  const terminal = isTerminalRunStatus(snap.status)
  let summary: string | undefined
  let incompleteReason: string | undefined
  let notificationId: string | undefined
  if (terminal) {
    const projected = projectSubagentExecutionResult({ childSession, runSnapshot: snap })
    summary = projected.summary
    if (projected.status === 'incomplete' && projected.incompleteReason) {
      incompleteReason = projected.incompleteReason
    }
    // notificationId 仅在有通知资格时生成，避免与投递分类规则漂移。
    if (isSubagentNotificationEligible(snap)) {
      notificationId = deriveSubagentNotificationId(runId, snap.terminalTransitionId!)
    }
  }
  return {
    runId,
    childSessionId: snap.sessionId,
    status,
    waitingUser,
    ...(notificationId ? { notificationId } : {}),
    ...(summary ? { summary } : {}),
    ...(incompleteReason ? { incompleteReason } : {})
  }
}

function isReady(target: TaskWaitTarget | null): target is TaskWaitTarget {
  if (!target) return false
  return isTerminalRunStatus(target.status) || target.status === 'waiting_user'
}

/**
 * task_wait — 让父 Agent 显式等待后台子代理终态或等待用户输入。
 * 集合入场冻结；subscribe 后用版本号消除复查与唤醒之间的窗口；timeout 不取消 child；
 * abort 可中断；finally 清理订阅、timer、abort listener。不注册到 builtin 模型工具集。
 */
export function createTaskWaitTool(deps: TaskWaitToolDeps): ToolExecutor {
  return {
    name: 'task_wait',
    description: '等待后台子代理到达终态或等待用户输入。run_ids 与 all_unfinished 二选一。',
    parameters: {
      type: 'object',
      properties: {
        run_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '要等待的子代理 run id 列表，非空；与 all_unfinished 二选一'
        },
        all_unfinished: {
          type: 'boolean',
          description: 'true 表示等待当前会话所有可访问的未终态后台子代理；与 run_ids 二选一'
        },
        timeout_ms: {
          type: 'integer',
          minimum: 0,
          maximum: 60000,
          description: `等待超时毫秒，默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}，0 表示立即复查返回`
        }
      },
      additionalProperties: false
    },
    executionMode: 'sequential',

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const store = context.sessionStore
      const sessionId = context.sessionId
      const runId = context.runId
      const invocationRef = context.invocationRef
      if (!store || !sessionId || !runId || !invocationRef) {
        return failure('task_wait 需要 sessionStore、sessionId、runId 与 invocationRef')
      }
      // invocationRef 必须与 context 一致，防止跨身份调用。
      if (invocationRef.sessionId !== sessionId || invocationRef.runId !== runId) {
        return failure('invocationRef 与当前会话/run 不一致')
      }

      // 严格二选一：检查属性存在性，不只是值。
      const hasRunIdsProp = Object.prototype.hasOwnProperty.call(args, 'run_ids')
      const hasAllUnfinishedProp = Object.prototype.hasOwnProperty.call(args, 'all_unfinished')
      if (hasRunIdsProp === hasAllUnfinishedProp) {
        return failure('必须且只能指定 run_ids 或 all_unfinished:true 之一')
      }

      // timeout_ms 在冻结目标前校验：即使 all_unfinished 为空，非法 timeout 也必须失败。
      const timeoutResult = validateTimeoutMs(args.timeout_ms)
      if (typeof timeoutResult === 'object') return failure(timeoutResult.error)
      const timeoutMs = timeoutResult

      // 参数/timeout 校验完成后，立刻检查已 aborted：必须早于目标投影、empty/ready/timeout=0 的任何成功返回。
      const abortSignal = context.abortSignal
      if (abortSignal?.aborted) {
        return failure('task_wait 被取消')
      }

      let frozenRunIds: readonly string[]
      if (hasRunIdsProp) {
        const rawRunIds = args.run_ids
        // 必须是非空、元素 trim 后非空的 string[]。
        if (
          !Array.isArray(rawRunIds) ||
          rawRunIds.length === 0 ||
          !rawRunIds.every(item => typeof item === 'string' && item.trim() !== '')
        ) {
          return failure('run_ids 必须是非空字符串数组')
        }
        const coordinator = deps.getRunCoordinator()
        const ancestorRunIds = collectAncestorRunIds(coordinator, runId)
        const seen = new Set<string>()
        const validated: string[] = []
        // 逐个校验：不存在/越权/自身/祖先任一失败则整体失败关闭。
        for (const id of rawRunIds as string[]) {
          if (seen.has(id)) continue
          seen.add(id)
          if (id === runId) return failure(`不能等待自身 run: ${id}`)
          if (ancestorRunIds.has(id)) return failure(`不能等待祖先 run: ${id}`)
          const snap = coordinator.getSnapshot(id)
          if (!snap?.dispatch) return failure(`目标 run 不存在或无派遣: ${id}`)
          const childSession = store.load(snap.sessionId)
          if (!childSession || childSession.kind !== 'subagent') {
            return failure(`目标 run 的子会话不存在: ${id}`)
          }
          if (!isDescendantSession(store, childSession, sessionId)) {
            return failure(`目标 run 不属于当前会话派生: ${id}`)
          }
          validated.push(id)
        }
        frozenRunIds = validated
      } else {
        // all_unfinished 必须严格为 true。
        if (args.all_unfinished !== true) {
          return failure('all_unfinished 必须为 true')
        }
        const coordinator = deps.getRunCoordinator()
        const ancestorRunIds = collectAncestorRunIds(coordinator, runId)
        const seen = new Set<string>()
        const collected: string[] = []
        for (const snap of coordinator.listDispatchSnapshots()) {
          if (snap.dispatch?.execution !== 'background_read_only') continue
          if (isTerminalRunStatus(snap.status)) continue
          if (snap.runId === runId || ancestorRunIds.has(snap.runId)) continue
          const childSession = store.load(snap.sessionId)
          if (!childSession || childSession.kind !== 'subagent') continue
          if (!isDescendantSession(store, childSession, sessionId)) continue
          if (seen.has(snap.runId)) continue
          seen.add(snap.runId)
          collected.push(snap.runId)
        }
        frozenRunIds = collected
      }

      if (frozenRunIds.length === 0) {
        return jsonResult({ ok: true, reason: 'empty', targets: [] })
      }

      const coordinator = deps.getRunCoordinator()
      const frozenSet = new Set(frozenRunIds)
      const projectAll = (): readonly TaskWaitTarget[] =>
        frozenRunIds
          .map(id => projectTarget(coordinator, store, id))
          .filter((t): t is TaskWaitTarget => t !== null)

      // 已有就绪立即返回。
      const initial = projectAll()
      if (initial.some(isReady)) {
        return jsonResult({ ok: true, reason: 'ready', targets: initial })
      }
      // timeout_ms=0 表示立即复查返回（不阻塞）。
      if (timeoutMs === 0) {
        return jsonResult({ ok: true, reason: 'timeout', targets: projectAll() })
      }

      // 版本号消除复查与唤醒之间的窗口：事件落在 capturedVersion 之后、wakeResolve 设置之前
      // 也能被检测到（设置 resolver 后立即比较版本号，变化则直接 resolve）。
      let changeVersion = 0
      let wakeResolve: (() => void) | undefined
      const unsubscribe = coordinator.subscribe(snapshot => {
        if (!frozenSet.has(snapshot.runId)) return
        changeVersion += 1
        wakeResolve?.()
      })

      let timer: NodeJS.Timeout | undefined
      let timedOut = false
      const timeoutPromise = new Promise<void>(resolve => {
        timer = setTimeout(() => {
          timedOut = true
          resolve()
        }, timeoutMs)
      })

      let aborted = false
      let abortResolve: (() => void) | undefined
      const abortPromise = new Promise<void>(resolve => {
        if (!abortSignal) return
        abortResolve = resolve
      })
      const onAbort = (): void => {
        aborted = true
        abortResolve?.()
      }
      if (abortSignal) {
        abortSignal.addEventListener('abort', onAbort, { once: true })
        // 注册后再次同步检查：消除「首次检查与 addEventListener 之间 abort」的窗口。
        if (abortSignal.aborted) onAbort()
      }

      try {
        // 等待任一就绪、超时或 abort。
        while (!timedOut && !aborted) {
          // 先捕获版本号，再复查；事件落在复查前/中/后都能被检测。
          const capturedVersion = changeVersion
          // 单次投影同时用于判定与返回：二次投影可能错过 waiting_user→running 的回退
          const observed = projectAll()
          if (observed.some(isReady)) {
            return jsonResult({ ok: true, reason: 'ready', targets: observed })
          }
          // 构造本轮唤醒 Promise；监听器触发时 resolve。
          const wakePromise = new Promise<void>(resolve => {
            wakeResolve = resolve
          })
          // 设置 resolver 后立即比较版本号：若复查期间已有事件，直接 resolve 本轮。
          if (changeVersion !== capturedVersion) {
            wakeResolve = undefined
            continue
          }
          await Promise.race([wakePromise, timeoutPromise, abortPromise])
          wakeResolve = undefined
          if (timedOut || aborted) break
        }

        if (aborted) {
          return failure('task_wait 被取消')
        }
        return jsonResult({ ok: true, reason: 'timeout', targets: projectAll() })
      } finally {
        wakeResolve = undefined
        unsubscribe()
        if (timer) clearTimeout(timer)
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      }
    }
  }
}

export default createTaskWaitTool
