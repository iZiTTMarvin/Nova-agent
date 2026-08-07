/**
 * compose 阶段条手动推进/回退 IPC
 *
 * 与 stage_transition 工具共用 SessionStore.applyComposeStageTransition 的校验与落盘，
 * 成功后向主窗口推送 agent:compose-stages-updated（payload 与工具事件一致），
 * renderer 阶段条只订阅这一个事件源，不出现第二条状态写入路径。
 */
import { handle } from './secureIpc'
import {
  AGENT_COMPOSE_STAGES_UPDATED,
  COMPOSE_APPLY_STAGE_TRANSITION
} from '../../shared/ipc/channels'
import { isComposeStageId, type ComposeStageAction } from '../../shared/composeLifecycle'
import { getSessionStore } from '../services/SessionStoreHost'
import { getMainWindow } from '../mainWindowRef'

/** 边界校验：外部输入按 unknown 收敛为合法 ComposeStageAction，形状非法直接拒绝 */
function parseComposeStageAction(raw: unknown): ComposeStageAction | null {
  if (!raw || typeof raw !== 'object') return null
  const action = raw as Record<string, unknown>
  if (action.type === 'complete') return { type: 'complete' }
  if (action.type === 'skip') {
    return typeof action.reason === 'string' ? { type: 'skip', reason: action.reason } : null
  }
  if (action.type === 'return') {
    return typeof action.reason === 'string' &&
      typeof action.targetStage === 'string' &&
      isComposeStageId(action.targetStage)
      ? { type: 'return', targetStage: action.targetStage, reason: action.reason }
      : null
  }
  return null
}

export function registerComposeStageHandler(): void {
  handle(COMPOSE_APPLY_STAGE_TRANSITION, async (_event, params: { sessionId?: unknown; action?: unknown }) => {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
    if (!sessionId) return { ok: false as const, error: '缺少会话 ID' }
    const action = parseComposeStageAction(params?.action)
    if (!action) return { ok: false as const, error: '非法的阶段操作' }

    // 阶段表是 compose 主会话的契约：缺少模式断言时，对其他会话调用会凭空建表落盘
    const sessionStore = getSessionStore()
    const session = sessionStore.load(sessionId)
    if (!session) return { ok: false as const, error: '会话不存在或已被删除' }
    if (session.mode !== 'compose' || session.kind !== 'primary') {
      return { ok: false as const, error: '仅 compose 主会话支持调整生命周期阶段' }
    }

    const result = sessionStore.applyComposeStageTransition(sessionId, action)
    if (!result) return { ok: false as const, error: '会话不存在或已被删除' }
    if (result.status === 'rejected') return { ok: false as const, error: result.error }

    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(AGENT_COMPOSE_STAGES_UPDATED, { sessionId, stages: result.stages })
    }
    return { ok: true as const, stages: result.stages }
  })
}
