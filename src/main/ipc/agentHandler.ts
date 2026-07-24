/**
 * Agent IPC Handler
 * 纯 IPC 适配层：将 renderer 命令转发到 turn / interaction 服务
 */
import { BrowserWindow } from 'electron'
import { handle } from './secureIpc'
import { SEND_MESSAGE, CANCEL_EXECUTION, RESPOND_PERMISSION, RESPOND_ASK_QUESTION } from '../../shared/ipc/channels'
import type { ModelClient } from '../../runtime/model/ModelClient'
import { ImageStore } from '../../runtime/storage/ImageStore'
import {
  sendAgentMessage,
  ensureTerminalHooksRegistered
} from '../agent/turn'
import {
  cancelExecution,
  respondPermission,
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

  handle(SEND_MESSAGE, async (_event, params) => {
    await sendAgentMessage(params, { getMainWindow, getModelClient, getImageStore })
  })

  handle(CANCEL_EXECUTION, async (_event, params) => cancelExecution(params ?? {}))

  handle(RESPOND_PERMISSION, async (_event, params) => respondPermission(params))

  handle(RESPOND_ASK_QUESTION, async (_event, params) => respondAskQuestion(params))
}
