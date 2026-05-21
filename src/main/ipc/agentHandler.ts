/**
 * Agent IPC Handler
 * 连接 renderer 的 IPC 命令和 runtime 的 AgentLoop
 * 将 AgentEvent 通过 IPC 推送到 renderer
 */
import { ipcMain, BrowserWindow } from 'electron'
import { SEND_MESSAGE, CANCEL_EXECUTION } from '../../shared/ipc/channels'
import { AgentLoop } from '../../runtime/agent/AgentLoop'
import { EventBus } from '../../runtime/agent/EventBus'
import { ToolRegistry } from '../../runtime/tools/ToolRegistry'
import { lsTool } from '../../runtime/tools/lsTool'
import { readTool } from '../../runtime/tools/readTool'
import { grepTool } from '../../runtime/tools/grepTool'
import { findTool } from '../../runtime/tools/findTool'
import type { ModelClient } from '../../runtime/model/ModelClient'
import type { AgentEvent } from '../../runtime/agent/types'
import { getCurrentProjectPath } from '../index'

/** 管理 AgentLoop 的生命周期 */
let agentLoop: AgentLoop | null = null

/**
 * 注册 agent 相关的 IPC handler
 * @param getMainWindow 获取当前活跃的 Electron 主窗口
 * @param getModelClient 获取当前配置的 ModelClient 实例
 */
export function registerAgentHandler(
  getMainWindow: () => BrowserWindow | null,
  getModelClient: () => ModelClient | null
): void {
  // 发送消息命令
  ipcMain.handle(SEND_MESSAGE, async (_event, params: { sessionId: string; content: string }): Promise<void> => {
    const modelClient = getModelClient()
    if (!modelClient) {
      throw new Error('模型未配置，请先在侧边栏底部设置中配置并连接模型。')
    }

    const projectPath = getCurrentProjectPath()
    if (!projectPath) {
      throw new Error('当前未选择项目工作区，请在侧边栏先选择一个本地目录。')
    }

    const eventBus = new EventBus()
    agentLoop = new AgentLoop(modelClient, eventBus)

    // 1. 设置 Agent 工作区边界
    agentLoop.setWorkingDir(projectPath)

    // 2. 初始化只读工具集（ls, read, grep, find）
    const toolRegistry = new ToolRegistry()
    toolRegistry.register(lsTool)
    toolRegistry.register(readTool)
    toolRegistry.register(grepTool)
    toolRegistry.register(findTool)
    agentLoop.setToolRegistry(toolRegistry)

    // 将 runtime 执行中触发的流式事件转发到 renderer 端，推动 UI 更新
    eventBus.on((event: AgentEvent) => {
      forwardEventToRenderer(getMainWindow(), event)
    })

    await agentLoop.sendMessage(params.content)
  })

  // 取消执行命令
  ipcMain.handle(CANCEL_EXECUTION, async (): Promise<void> => {
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
