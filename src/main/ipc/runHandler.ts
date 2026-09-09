/**
 * Run 相关 IPC：snapshot 查询、等待徽标、强制终止
 */
import { handle } from './secureIpc'
import { toRendererRunSnapshot } from '../../shared/run/rendererProjection'
import {
  RUN_GET_SNAPSHOT,
  RUN_LIST_WAITING,
  RUN_FORCE_TERMINATE
} from '../../shared/ipc/channels'
import { getRunCoordinator, getRunExecutionRegistry, getActiveRunId, setActiveRunId } from '../services/RunCoordinatorHost'

export function registerRunHandler(): void {
  handle(RUN_GET_SNAPSHOT, async (_event, params: { sessionId: string; runId?: string }) => {
    const coord = getRunCoordinator()
    const snapshot = params.runId
      ? coord.getSnapshot(params.runId)
      : coord.getSnapshotForSession(params.sessionId)
    return {
      snapshot: toRendererRunSnapshot(snapshot),
      waitingSessions: coord.listWaitingSessions()
    }
  })

  handle(RUN_LIST_WAITING, async () => {
    return getRunCoordinator().listWaitingSessions()
  })

  handle(RUN_FORCE_TERMINATE, async (_event, params: { runId: string }) => {
    const coord = getRunCoordinator()
    const registry = getRunExecutionRegistry()
    const before = coord.getSnapshot(params.runId)
    if (!before) return { ok: false, snapshot: null }

    // 先持久化「正在取消」，再向真实执行发 abort 信号。
    coord.beginCancel(params.runId)
    coord.inbox.cancelAllForRun(params.runId)

    let result: Awaited<ReturnType<typeof registry.abort>>
    try {
      result = await registry.abort(params.runId, 'force_terminate')
    } catch (err) {
      // abort 路径抛错也必须进入 interrupted，不能永久停在 cancelling
      const reason = err instanceof Error ? err.message : String(err)
      coord.invalidateExecutionGeneration(params.runId)
      const snapshot = coord.commitTerminal({
        runId: params.runId,
        status: 'interrupted',
        reason: `force_terminate_abort_error:${reason}`
      })
      if (getActiveRunId() === params.runId) {
        setActiveRunId(null)
      }
      return { ok: !!snapshot, snapshot: toRendererRunSnapshot(snapshot), lingering: true, abortError: reason }
    }

    if (result.abortError) {
      // abort() 内部吞掉的异常：同样按 interrupted 处理
      coord.invalidateExecutionGeneration(params.runId)
      const snapshot = coord.commitTerminal({
        runId: params.runId,
        status: 'interrupted',
        reason: `force_terminate_abort_error:${result.abortError}`
      })
      if (getActiveRunId() === params.runId) {
        setActiveRunId(null)
      }
      // lingering handle 保留至 settled 自动注销；禁止此处 unregister
      return {
        ok: !!snapshot,
        snapshot: toRendererRunSnapshot(snapshot),
        lingering: true,
        abortError: result.abortError
      }
    }

    if (result.settled) {
      const snapshot = coord.commitTerminal({
        runId: params.runId,
        status: 'cancelled',
        reason: 'force_terminate'
      })
      // 已 settled：按 generation 注销（若 settled 回调已清则 no-op）
      if (result.generation != null) {
        registry.unregister(params.runId, result.generation)
      }
      if (getActiveRunId() === params.runId) {
        setActiveRunId(null)
      }
      return { ok: !!snapshot, snapshot: toRendererRunSnapshot(snapshot), lingering: false }
    }

    // grace 超时：提交 interrupted + 失效 generation；**不得** unregister lingering handle
    coord.invalidateExecutionGeneration(params.runId)
    const snapshot = coord.commitTerminal({
      runId: params.runId,
      status: 'interrupted',
      reason: 'force_terminate_grace_expired'
    })
    if (getActiveRunId() === params.runId) {
      setActiveRunId(null)
    }
    return { ok: !!snapshot, snapshot: toRendererRunSnapshot(snapshot), lingering: true }
  })
}
