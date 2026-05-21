/**
 * Agent IPC Handler
 * 连接 renderer 的 IPC 命令和 runtime 的 AgentLoop
 * 将 AgentEvent 通过 IPC 推送到 renderer
 * S9：集成 CheckpointManager、SessionStore、流式内容累积
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
import { getCurrentMode } from '../index'
import { getSessionStore } from './sessionHandler'
import type { SessionMessage, SessionToolCall } from '../../runtime/sessions/types'

/** 管理 AgentLoop 的生命周期 */
let agentLoop: AgentLoop | null = null

/**
 * 流式内容累积器
 * 在 message_start 到 message_end 之间累积 assistant 消息的完整内容，
 * 包括文本增量和工具调用记录，用于最终保存到 SessionStore
 */
interface StreamAccumulator {
  content: string
  toolCalls: SessionToolCall[]
}

/** 当前正在累积的流式消息映射：messageId → 累积器 */
const activeStreams = new Map<string, StreamAccumulator>()

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

    // 从会话数据中获取 workspaceRoot，确保使用该会话绑定的项目目录
    const sessionStore = getSessionStore()
    const session = sessionStore.load(params.sessionId)
    if (!session) {
      throw new Error(`会话 ${params.sessionId} 不存在`)
    }
    const projectPath = session.workspaceRoot

    const eventBus = new EventBus()
    agentLoop = new AgentLoop(modelClient, eventBus)

    // 1. 设置 Agent 工作区边界（使用会话的工作区目录）
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

    // 5. 注入 CheckpointManager（S9：支持会话回退和文件拒绝，路径与会话工作区一致）
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
    sessionStore.appendMessage(params.sessionId, userMessage)

    // 将 runtime 执行中触发的流式事件转发到 renderer 端，
    // 同时累积完整内容用于最终持久化
    eventBus.on((event: AgentEvent) => {
      forwardEventToRenderer(getMainWindow(), event)
      accumulateStreamEvent(params.sessionId, event)
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

/**
 * 累积流式事件内容
 *
 * message_start → 创建累积器
 * text_delta → 追加文本内容
 * tool_call → 追加工具调用记录
 * tool_result → 更新对应工具调用的执行结果
 * message_end → 将完整内容保存到 SessionStore
 * error → 将错误消息保存到 SessionStore
 */
function accumulateStreamEvent(sessionId: string, event: AgentEvent): void {
  switch (event.type) {
    case 'message_start': {
      activeStreams.set(event.messageId, { content: '', toolCalls: [] })
      break
    }
    case 'thinking_delta': {
      // 思考内容仅用于前端展示，不持久化
      break
    }
    case 'text_delta': {
      const stream = activeStreams.get(event.messageId)
      if (stream) {
        stream.content += event.delta
      }
      break
    }
    case 'tool_call': {
      const stream = activeStreams.get(event.messageId)
      if (stream) {
        stream.toolCalls.push({
          id: event.toolCallId,
          name: event.toolName,
          arguments: JSON.stringify(event.args),
          result: undefined // 结果在 tool_result 事件中填充
        })
      }
      break
    }
    case 'tool_result': {
      const stream = activeStreams.get(event.messageId)
      if (stream) {
        // 通过 toolCallId 精确匹配工具调用记录
        const targetIdx = stream.toolCalls.findIndex(
          tc => tc.id === event.toolCallId
        )
        if (targetIdx !== -1) {
          stream.toolCalls[targetIdx].result = event.result
        }
      }
      break
    }
    case 'message_end': {
      const stream = activeStreams.get(event.messageId)
      if (stream) {
        activeStreams.delete(event.messageId)
        saveAssistantMessage(sessionId, event.messageId, stream.content, stream.toolCalls)
      }
      break
    }
    case 'error': {
      const stream = activeStreams.get(event.messageId)
      if (stream) {
        activeStreams.delete(event.messageId)
      }
      saveErrorMessage(sessionId, event.messageId, event.error)
      break
    }
  }
}

/** 保存完整的 assistant 消息到会话存储（含文本内容和工具调用记录） */
function saveAssistantMessage(
  sessionId: string,
  messageId: string,
  content: string,
  toolCalls: SessionToolCall[]
): void {
  const sessionStore = getSessionStore()
  const assistantMessage: SessionMessage = {
    id: messageId,
    role: 'assistant',
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
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
    case 'thinking_delta':
      webContents.send('agent:thinking-delta', { messageId: event.messageId, delta: event.delta })
      break
    case 'text_delta':
      webContents.send('agent:text-delta', { messageId: event.messageId, delta: event.delta })
      break
    case 'tool_call':
      webContents.send('agent:tool-call', { messageId: event.messageId, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args })
      break
    case 'tool_result':
      webContents.send('agent:tool-result', { messageId: event.messageId, toolCallId: event.toolCallId, toolName: event.toolName, result: event.result })
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
