/**
 * 计划审阅卡「批准」按钮专用 IPC
 *
 * 与 composeStageHandler 的手动阶段推进分开：批准只推进计划确认门本身，
 * 不改动阶段表。校验通过后向主窗口推送 agent:compose-plan-approval-updated，
 * renderer 的审阅卡与阶段条只订阅这一个事件源。
 */
import { handle } from './secureIpc'
import {
  AGENT_COMPOSE_PLAN_APPROVAL_UPDATED,
  COMPOSE_APPROVE_PLAN
} from '../../shared/ipc/channels'
import { createInitialStageTable, getComposeStageCursor } from '../../shared/composeLifecycle'
import { getSessionStore } from '../services/SessionStoreHost'
import { getMainWindow } from '../mainWindowRef'

export function registerComposePlanApprovalHandler(): void {
  handle(COMPOSE_APPROVE_PLAN, async (_event, params: { sessionId?: unknown }) => {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
    if (!sessionId) return { ok: false as const, error: '缺少会话 ID' }

    const sessionStore = getSessionStore()
    const session = sessionStore.load(sessionId)
    if (!session) return { ok: false as const, error: '会话不存在或已被删除' }
    if (session.mode !== 'compose' || session.kind !== 'primary') {
      return { ok: false as const, error: '仅 compose 主会话可批准计划' }
    }
    if (!session.activePlan) {
      return { ok: false as const, error: '当前会话尚无可批准的计划' }
    }

    const stages = sessionStore.getComposeStages(sessionId)
    const cursor = getComposeStageCursor(stages ?? createInitialStageTable())
    if (cursor.currentStageId !== 'plan') {
      return { ok: false as const, error: '仅计划阶段可批准计划' }
    }

    const approval = sessionStore.approveComposePlan(sessionId, { auto: false })
    if (!approval) return { ok: false as const, error: '会话不存在或已被删除' }

    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(AGENT_COMPOSE_PLAN_APPROVAL_UPDATED, { sessionId, approval })
    }
    return { ok: true as const, approval }
  })
}
