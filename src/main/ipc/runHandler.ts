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
import {
  getRunCoordinator,
  getRunExecutionRegistry,
  getActiveRunId,
  setActiveRunId
} from '../services/RunCoordinatorHost'
import { getSessionStore } from './sessionHandler'

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
    const result = await registry.abort(params.runId, 'force_terminate')
    const snapshot = coord.commitTerminal({
      runId: params.runId,
      status: result.settled ? 'cancelled' : 'interrupted',
      reason: result.settled ? 'force_terminate' : 'force_terminate_grace_expired'
    })
    // 已收敛或已被标为 interrupted 后，不能再让旧句柄参与新的 run。
    registry.unregister(params.runId)
    if (getActiveRunId() === params.runId) {
      setActiveRunId(null)
    }
    return { ok: !!snapshot, snapshot, lingering: result.lingering }
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
      // 最小钩子：回滚本轮依赖 checkpoint；此处仅标记意图并返回已提交工具列表供 UI
      // 实际文件回滚仍走既有 revertWorkspaceForMessageIds / checkpoint 路径
      const committed = (snap.toolCommits ?? []).filter(c => c.phase === 'committed')
      try {
        const sessionStore = getSessionStore()
        // 仅提供 API 入口；具体 undo 由 renderer/WorkspaceService 既有能力承接
        void sessionStore
        return {
          ok: true,
          steps: committed,
          message: '请使用消息回退 / checkpoint 回滚本轮已提交的文件修改',
          snapshot: snap
        }
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : '回滚失败',
          snapshot: snap
        }
      }
    }

    // continue：从 interrupted 进入 resuming，供后续 SEND_MESSAGE / 用户「继续」衔接
    if (snap.status !== 'interrupted') {
      return {
        ok: false,
        message: `当前状态 ${snap.status} 不可 continue`,
        snapshot: snap
      }
    }
    // interrupted → resuming（不自动重放非幂等工具；用户发「继续」时新 turn 分析）
    const next = coord.transition(params.runId, 'resuming', 'user_continue')
    return {
      ok: true,
      message: '已标记为可继续；请发送「继续」让 Agent 基于已提交步骤继续分析（不会自动重放未提交的非幂等工具）',
      steps: snap.toolCommits ?? [],
      snapshot: next
    }
  })
}
