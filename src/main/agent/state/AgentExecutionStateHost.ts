/**
 * 主进程 Agent 执行状态查询宿主。
 *
 * 职责：
 * - 维护按会话隔离的 readState（替代旧的全局单例），记录「模型已读过的文件」。
 * - 从 RunCoordinator / RunExecutionRegistry 派生「是否正在执行」「某会话是否占用 turn」查询。
 *
 * 不持久化 run，不复制 durable 状态。
 */
import { createReadState, type ReadState } from '../../../runtime/tools/editTool'
import {
  getActiveRunId,
  getRunCoordinator,
  getRunExecutionRegistry
} from '../../services/RunCoordinatorHost'

/**
 * 按会话隔离的 readState 表。
 *
 * 同一会话跨多次 SEND_MESSAGE 复用同一份 readState，使得连续发消息时第二条能继续
 * 享受第一条已读的文件状态（否则 edit 会陷入「File has not been read yet」循环）。
 * 不同会话之间各自独立，避免 A 会话读过的文件污染 B 会话的 edit 校验。
 *
 * Sub agent（task / skill fork）通过 cloneReadState 拿深拷贝，不污染任何会话实例。
 * 会话切换 / 创建 / 回退 / 删除时由 sessionHandler / WorkspaceService 显式清理对应会话。
 */
const readStateBySession = new Map<string, ReadState>()

/** 取（必要时懒创建）指定会话的 readState。跨 turn 复用同一实例。 */
export function getReadStateForSession(sessionId: string): ReadState {
  let rs = readStateBySession.get(sessionId)
  if (!rs) {
    rs = createReadState()
    readStateBySession.set(sessionId, rs)
  }
  return rs
}

/** 清空指定会话的 readState（保留 Map 槽位，供该会话下一轮重新累积）。会话切换/回退时调用。 */
export function clearReadStateForSession(sessionId: string): void {
  readStateBySession.get(sessionId)?.clear()
}

/** 彻底回收指定会话的 readState（会话删除时调用，释放内存）。 */
export function deleteReadStateForSession(sessionId: string): void {
  readStateBySession.delete(sessionId)
}

/**
 * 供 WorkspaceService 分叉 IPC 守卫：生成中禁止改 currentLeafId。
 * 权威来源：RunCoordinator 非终态 run，或仍有未 settled 的执行句柄（含 interrupted 后 lingering）。
 *
 * 注意：这是「全局」判断，分叉操作要求整个应用没有任何 run 在跑。
 * SEND_MESSAGE 入口请改用按会话的 isSessionTurnInProgress。
 */
export function isAgentTurnInProgress(): boolean {
  try {
    if (getRunExecutionRegistry().hasUnsettledHandle()) return true
    return getRunCoordinator().listActiveRuns().some(run =>
      run.status === 'running' ||
      run.status === 'retrying' ||
      run.status === 'resuming' ||
      run.status === 'cancelling'
    )
  } catch {
    return getActiveRunId() !== null
  }
}

/**
 * 按会话判断该会话是否仍占用一轮 turn。
 *
 * 并发模型：不同会话允许同时跑；同一会话同时最多一个 active run。
 * 当该会话存在占用 turn 的 run，或该会话对应的执行句柄尚未收敛时，返回 true，
 * 入口锁据此把同会话的新消息推入 steering queue，而不是直接开新 turn。
 */
export function isSessionTurnInProgress(sessionId: string): boolean {
  try {
    const coord = getRunCoordinator()
    if (coord.hasActiveRunForSession(sessionId)) return true
    // 句柄尚未 settled 的 run 中，若任一归属该会话，也视为占用
    const registry = getRunExecutionRegistry()
    for (const runId of registry.listActiveRunIds()) {
      const snap = coord.getSnapshot(runId)
      if (snap && snap.sessionId === sessionId) return true
    }
    return false
  } catch {
    // 协调器尚未初始化时，回退到全局 activeRunId 的会话比对
    const bound = getActiveRunId()
    if (!bound) return false
    try {
      const snap = getRunCoordinator().getSnapshot(bound)
      return snap?.sessionId === sessionId
    } catch {
      return false
    }
  }
}

/** 供跨会话守卫：当前活跃轮次所属会话 id（无进行中轮次时为 null） */
export function getActiveTurnSessionId(): string | null {
  try {
    const active = getRunCoordinator().listActiveRuns().filter(run =>
      run.status === 'running' ||
      run.status === 'retrying' ||
      run.status === 'resuming' ||
      run.status === 'cancelling'
    )
    if (active.length === 0) return null
    // 优先当前 SEND_MESSAGE 绑定的 run
    const bound = getActiveRunId()
    if (bound) {
      const snap = active.find(s => s.runId === bound)
      if (snap) return snap.sessionId
    }
    return active[0]?.sessionId ?? null
  } catch {
    return null
  }
}

/** 测试用：重置 readState 表，避免用例间串污染。 */
export function resetReadStateHostForTests(): void {
  readStateBySession.clear()
}
