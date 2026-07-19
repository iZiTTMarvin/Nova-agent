/**
 * 主进程 Agent 执行状态查询宿主。
 *
 * 拥有跨 turn 复用的 mainReadState，并从 RunCoordinator / RunExecutionRegistry
 * 派生「是否正在执行」「当前活跃会话」查询。不持久化 run，不复制 durable 状态。
 */
import { createReadState, type ReadState } from '../../../runtime/tools/editTool'
import {
  getActiveRunId,
  getRunCoordinator,
  getRunExecutionRegistry
} from '../../services/RunCoordinatorHost'

/**
 * 主 readState：跨多次 SEND_MESSAGE 复用，记录「模型已读过的文件」。
 *
 * 每次新建 AgentLoop 时通过 setReadState 注入，使得同一会话连发多条消息时
 * 第二条消息能继续享受第一条消息的 read 状态（否则 edit 会陷入
 * 「File has not been read yet」循环）。
 *
 * Sub agent（task / skill fork）通过 cloneReadState 拿深拷贝，不污染此实例。
 * 会话切换 / 创建 / 回退时由 sessionHandler 显式 clear。
 */
const mainReadState: ReadState = createReadState()

/** 会话切换/创建/回退时清空 readState，避免跨会话污染 */
export function getMainReadState(): ReadState {
  return mainReadState
}

/**
 * 供 WorkspaceService 分叉 IPC 守卫：生成中禁止改 currentLeafId。
 * 权威来源：RunCoordinator 非终态 run，或仍有未 settled 的执行句柄（含 interrupted 后 lingering）。
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
