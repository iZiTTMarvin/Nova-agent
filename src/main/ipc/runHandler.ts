/**
 * Run 相关 IPC：snapshot 查询、等待徽标、强制终止、interrupted 恢复入口
 */
import { handle } from './secureIpc'
import {
  RUN_GET_SNAPSHOT,
  RUN_LIST_WAITING,
  RUN_FORCE_TERMINATE,
  RUN_INTERRUPTED_ACTION
} from '../../shared/ipc/channels'
import { getRunCoordinator, getRunExecutionRegistry, getActiveRunId, setActiveRunId } from '../services/RunCoordinatorHost'

export function registerRunHandler(): void {
  handle(RUN_GET_SNAPSHOT, async (_event, params: { sessionId: string; runId?: string }) => {
    const coord = getRunCoordinator()
    const snapshot = params.runId
      ? coord.getSnapshot(params.runId)
      : coord.getSnapshotForSession(params.sessionId)
    return {
      snapshot,
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
      return { ok: !!snapshot, snapshot, lingering: true, abortError: reason }
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
        snapshot,
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
      return { ok: !!snapshot, snapshot, lingering: false }
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
    return { ok: !!snapshot, snapshot, lingering: true }
  })

  handle(RUN_INTERRUPTED_ACTION, async (_event, params: {
    runId: string
    action: 'continue' | 'rollback' | 'inspect'
  }) => {
    const coord = getRunCoordinator()
    const snap = coord.getSnapshot(params.runId)
    if (!snap) {
      return { ok: false, message: 'run 不存在', snapshot: null }
    }

    if (params.action === 'inspect') {
      return {
        ok: true,
        steps: snap.toolCommits ?? [],
        message: `共 ${(snap.toolCommits ?? []).length} 个工具步骤`,
        snapshot: snap
      }
    }

    if (params.action === 'rollback') {
      // 禁止假成功：无 FileEffectReceipt / checkpoint 绑定时明确失败
      const committed = (snap.toolCommits ?? []).filter(c => c.phase === 'committed')
      try {
        const { previewRollback, confirmRollback, listFileEffects } = await import(
          '../../runtime/workflow/v2/EffectReceipt'
        )
        const workspaceRoot = snap.workspaceId
        const effects = listFileEffects(workspaceRoot, params.runId)
        if (effects.length === 0) {
          return {
            ok: false,
            steps: committed,
            message:
              '无可回滚的文件副作用凭证。请使用会话消息回退 / 逐文件 checkpoint；未执行任何文件回滚。',
            snapshot: snap
          }
        }
        // 本 IPC 仍为预览+确认合一的兼容路径；真正拆分见 rollback-preview/confirm 通道
        const preview = previewRollback(workspaceRoot, params.runId)
        const result = confirmRollback(workspaceRoot, params.runId)
        const hasConflict = preview.conflicts.length > 0 || preview.missingBackup.length > 0
        return {
          ok: result.ok && !hasConflict,
          steps: committed,
          message: result.ok && !hasConflict
            ? `已按 effect 凭证回滚：恢复 ${preview.willRestore.length}，删除 ${preview.willDelete.length}`
            : `回滚未完全成功：冲突 ${preview.conflicts.length}，缺备份 ${preview.missingBackup.length}`,
          snapshot: snap,
          preview,
          results: result.results
        }
      } catch (err) {
        return {
          ok: false,
          steps: committed,
          message: err instanceof Error ? err.message : '回滚失败',
          snapshot: snap
        }
      }
    }

    if (snap.status !== 'interrupted') {
      return {
        ok: false,
        message: `当前状态 ${snap.status} 不可 continue`,
        snapshot: snap
      }
    }
    // interrupted → resuming：统一 commit 保证 sequence 单调，避免 Renderer 丢事件
    const next = coord.transition(params.runId, 'resuming', 'user_continue')
    return {
      ok: true,
      message: '已标记为可继续；请发送「继续」让 Agent 基于已提交步骤继续分析（不会自动重放未提交的非幂等工具）',
      steps: snap.toolCommits ?? [],
      snapshot: next
    }
  })
}
