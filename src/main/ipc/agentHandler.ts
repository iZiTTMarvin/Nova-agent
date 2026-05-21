/**
 * Agent IPC Handler
 * 连接 renderer 的 IPC 命令和 runtime 的 AgentLoop
 * 将 AgentEvent 通过 IPC 推送到 renderer
 * S9：集成 CheckpointManager 和 SessionStore
 */
import { ipcMain, BrowserWindow } from 'electron'
import { SEND_MESSAGE, CANCEL_EXECUTION, RESPOND_PERMISSION } from '../../shared/ipc/channels'
import { AgentLoop } from '../../runtime/agent/AgentLoop'
import { EventBus } from '../../runtime/agent/EventBus'
import { ToolRegistry } from '../../runtime/tools/ToolRegistry'
import { lsTool } from '../../runtime/tools/lsTool'
import { readTool } from '../../runtime/tools/readTool'
import { grepTool } from '../../runtime/tools/grepTool'
import { findTool } from '../../runtime/tools/findTool'
import { editTool } from '../../runtime/tools/editTool'
import { writeTool } from '../../runtime/tools/writeTool'
import { bashTool } from '../../runtime/tools/bashTool'
import { PermissionManager } from '../../runtime/permissions/PermissionManager'
import { CheckpointManager } from '../../runtime/checkpoints/CheckpointManager'
import type { ModelClient } from '../../runtime/model/ModelClient'
import type { AgentEvent } from '../../runtime/agent/types'
import type { PermissionDecision } from '../../shared/session/types'
import { getCurrentProjectPath, getCurrentMode } from '../index'
import { getSessionStore } from './sessionHandler'
import type { SessionMessage } from '../../runtime/sessions/types'

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

    // 2. 初始化工具集（7 个内置工具）
    const toolRegistry = new ToolRegistry()
    toolRegistry.register(lsTool)
    toolRegistry.register(readTool)
    toolRegistry.register(grepTool)
    toolRegistry.register(findTool)
    toolRegistry.register(editTool)
    toolRegistry.register(writeTool)
    toolRegistry.register(bashTool)
    agentLoop.setToolRegistry(toolRegistry)

    // 3. 注入权限决策引擎
    const permissionManager = new PermissionManager()
    agentLoop.setPermissionManager(permissionManager)

    // 4. 同步当前运行模式
    agentLoop.setMode(getCurrentMode())

    // 5. 注入 CheckpointManager（S9：支持会话回退和文件拒绝）
    const sessionStore = getSessionStore()
    const checkpointManager = new CheckpointManager({
      checkpointDir: sessionStore.getSessionsDir(),
      sessionId: params.sessionId,
      workspaceRoot: projectPath
    })
    agentLoop.setCheckpointManager(checkpointManager)

    // 6. 保存用户消息到会话存储
    const userMessage: SessionMessage = {
      id: `msg_${Date.now()}_user`,
      role: 'user',
      content: params.content,
      timestamp: Date.now()
    }
    const session = sessionStore.load(params.sessionId)
    if (session) {
      sessionStore.appendMessage(params.sessionId, userMessage)
    }

    // 将 runtime 执行中触发的流式事件转发到 renderer 端，推动 UI 更新
    eventBus.on((event: AgentEvent) => {
      forwardEventToRenderer(getMainWindow(), event)

      // 消息结束后保存 assistant 消息到会话存储
      if (event.type === 'message_end') {
        saveAssistantMessage(params.sessionId, event.messageId)
      }
      // 错误也保存为 assistant 消息
      if (event.type === 'error') {
        saveErrorMessage(params.sessionId, event.messageId, event.error)
      }
    })

    await agentLoop.sendMessage(params.content)
  })

  // 取消执行命令
  ipcMain.handle(CANCEL_EXECUTION, async (): Promise<void> => {
    agentLoop?.cancel()
  })

  // 用户回应权限请求（allow / deny）
  ipcMain.handle(RESPOND_PERMISSION, async (_event, params: { requestId: string; decision: PermissionDecision }): Promise<void> => {
    if (!agentLoop) return
    const granted = params.decision === 'allow'
    agentLoop.respondPermission(params.requestId, granted)
  })
}

/** 保存 assistant 消息到会话存储 */
function saveAssistantMessage(sessionId: string, messageId: string): void {
  const sessionStore = getSessionStore()
  const session = sessionStore.load(sessionId)
  if (!session) return

  // 从 AgentLoop 的上下文中提取完整的 assistant 消息
  // 当前简化处理：只记录消息 ID 和时间戳，内容在流式过程中由 renderer 追踪
  const assistantMessage: SessionMessage = {
    id: messageId,
    role: 'assistant',
    content: '', // 内容在流式过程中已通过 text_delta 事件发给 renderer，这里为空
    timestamp: Date.now()
  }
  sessionStore.appendMessage(sessionId, assistantMessage)
}

/** 保存错误消息到会话存储 */
function saveErrorMessage(sessionId: string, messageId: string, error: string): void {
  const sessionStore = getSessionStore()
  const errorMessage: SessionMessage = {
    id: messageId,
    role: 'assistant',
    content: error,
    timestamp: Date.now()
  }
  sessionStore.appendMessage(sessionId, errorMessage)
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
        messageId: event.messageId,
        requestId: event.requestId,
        toolName: event.toolName,
        args: event.args,
        riskLevel: event.riskLevel,
        reason: event.reason
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
