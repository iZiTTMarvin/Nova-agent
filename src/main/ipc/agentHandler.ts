/**
 * Agent IPC Handler
 * 连接 renderer 的 IPC 命令和 runtime 的 AgentLoop
 * 将 AgentEvent 通过 IPC 推送到 renderer
 */
import { ipcMain, BrowserWindow } from 'electron'
import { SEND_MESSAGE, CANCEL_EXECUTION } from '../../shared/ipc/channels'
import { AgentLoop } from '../../runtime/agent/AgentLoop'
import { EventBus } from '../../runtime/agent/EventBus'
import type { ModelClient } from '../../runtime/model/ModelClient'
import type { AgentEvent } from '../../runtime/agent/types'

/** 管理 AgentLoop 的生命周期 */
let agentLoop: AgentLoop | null = null

/**
 * 注册 agent 相关的 IPC handler
 * @param getModelClient 获取当前配置的 ModelClient 实例
 */
export function registerAgentHandler(
  getMainWindow: () => BrowserWindow | null,
  getModelClient: () => ModelClient | null
): void {
  // 发送消息
  ipcMain.handle(SEND_MESSAGE, async (_event, params: { sessionId: string; content: string }) => {
    const modelClient = getModelClient()
    if (!modelClient) {
      throw new Error('模型未配置，请先在设置中配置模型')
    }

    // 每次发消息时创建新的 AgentLoop（S3 简化处理，S9 会改用会话管理）
    const eventBus = new EventBus()
    agentLoop = new AgentLoop(modelClient, eventBus)

    // 将 runtime 事件转发到 renderer
    eventBus.on((event: AgentEvent) => {
      forwardEventToRenderer(getMainWindow(), event)
    })

    await agentLoop.sendMessage(params.content)
  })

  // 取消执行
  ipcMain.handle(CANCEL_EXECUTION, async () => {
    agentLoop?.cancel()
  })
}

/** 将 AgentEvent 映射到 IPC 事件 channel 并推送到 renderer */
function forwardEventToRenderer(
  mainWindow: BrowserWindow | null,
  event: AgentEvent
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const webContents = mainWindow.webContents
  if (webContents.isDestroyed()) return

  switch (event.type) {
    case 'message_start':
      webContents.send('agent:message-start', { messageId: event.messageId })
      break
    case 'text_delta':
      webContents.send('agent:text-delta', { messageId: event.messageId, delta: event.delta })
      break
    case 'tool_call':
      webContents.send('agent:tool-call', { messageId: event.messageId, toolName: event.toolName, args: event.args })
      break
    case 'tool_result':
      webContents.send('agent:tool-result', { messageId: event.messageId, toolName: event.toolName, result: event.result })
      break
    case 'permission_request':
      webContents.send('agent:permission-request', {
        requestId: event.requestId,
        toolName: event.toolName,
        args: event.args,
        risk: event.risk
      })
      break
    case 'diff_update':
      webContents.send('agent:diff-update', { messageId: event.messageId, diffs: event.diffs })
      break
    case 'verification_result':
      webContents.send('agent:verification-result', { messageId: event.messageId, result: event.result })
      break
    case 'error':
      webContents.send('agent:error', { messageId: event.messageId, error: event.error })
      break
    case 'message_end':
      webContents.send('agent:message-end', { messageId: event.messageId })
      break
  }
}
