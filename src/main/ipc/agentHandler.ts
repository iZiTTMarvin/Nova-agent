/**
 * Agent IPC Handler
 * 纯 IPC 适配层：将 renderer 命令转发到 turn / interaction 服务
 */
import { BrowserWindow } from 'electron'
import { handle } from './secureIpc'
import {
  SEND_MESSAGE,
  CANCEL_EXECUTION,
  RESPOND_PERMISSION,
  RESPOND_PLAN_REVIEW,
  RESPOND_ASK_QUESTION
} from '../../shared/ipc/channels'
import { parsePlanReviewCommand } from '../../shared/planReview'
import type { ModelClient } from '../../runtime/model/ModelClient'
import { ImageStore } from '../../runtime/storage/ImageStore'
import {
  sendAgentMessage,
  ensureTerminalHooksRegistered,
  configureIdleRelay,
  resumeIdleRelaysAfterStartup
} from '../agent/turn'
import { getSubagentDeliveryCoordinator } from '../services/SubagentDeliveryCoordinatorHost'
import { ensureProcessCleanupWired } from '../services/ProcessCleanupHost'
import {
  cancelExecution,
  respondPermission,
  respondPlanReview,
  respondAskQuestion
} from '../agent/interaction'

/**
 * 注册 agent 相关的 IPC handler
 * @param getMainWindow 获取当前活跃的 Electron 主窗口
 * @param getModelClient 获取当前配置的 ModelClient 实例
 */
export function registerAgentHandler(
  getMainWindow: () => BrowserWindow | null,
  getModelClient: () => ModelClient | null,
  getImageStore: () => ImageStore
): void {
  ensureTerminalHooksRegistered()
  configureIdleRelay({ getMainWindow, getModelClient, getImageStore })
  ensureProcessCleanupWired()
  // 启动时 RunCoordinator 对账与草稿恢复已在 registerIpcHandlers 完成；
  // 此处先补账（幂等补绑/补消息），再接管对账后仍有效的预约。
  try {
    getSubagentDeliveryCoordinator().reconcileDeliveryOnStartup()
  } catch (error) {
    console.error('[agentHandler] 接力投递启动对账失败:', error)
  }
  resumeIdleRelaysAfterStartup()

  handle(SEND_MESSAGE, async (_event, params) => {
    // 显式挑选用户字段：renderer 不能伪造内部接力入场
    return sendAgentMessage(
      {
        sessionId: params.sessionId,
        content: params.content,
        ...(params.userMessageId !== undefined ? { userMessageId: params.userMessageId } : {}),
        ...(params.images !== undefined ? { images: params.images } : {}),
        ...(params.regenerate !== undefined ? { regenerate: params.regenerate } : {})
      },
      { getMainWindow, getModelClient, getImageStore }
    )
  })

  handle(CANCEL_EXECUTION, async (_event, params) => cancelExecution(params))

  handle(RESPOND_PERMISSION, async (_event, params) => respondPermission(params))

  handle(RESPOND_PLAN_REVIEW, async (_event, params: unknown) => {
    const parsed = parsePlanReviewCommand(params)
    if (!parsed.ok) {
      return {
        ok: false as const,
        code: 'identity_mismatch' as const,
        message: parsed.message,
        firstApplied: false
      }
    }
    return respondPlanReview(parsed.command)
  })

  handle(RESPOND_ASK_QUESTION, async (_event, params) => respondAskQuestion(params))
}
