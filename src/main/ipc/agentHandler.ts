/**
 * Agent IPC Handler
 * 连接 renderer 的 IPC 命令和 runtime 的 AgentLoop
 * 将 AgentEvent 通过 IPC 推送到 renderer
 * S9：集成 CheckpointManager、SessionStore、流式内容累积
 */
import { ipcMain, BrowserWindow } from 'electron'
import { SEND_MESSAGE, CANCEL_EXECUTION, RESPOND_PERMISSION, RESPOND_VERIFICATION_PERMISSION } from '../../shared/ipc/channels'
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
import { buildMessageDiffState } from '../../runtime/checkpoints/diffState'
import { readManifest } from '../../runtime/checkpoints/manifest'
import type { ModelClient } from '../../runtime/model/ModelClient'
import type { AgentEvent } from '../../runtime/agent/types'
import type { Mode, PermissionDecision } from '../../shared/session/types'
import { getSessionStore } from './sessionHandler'
import type { SessionMessage, SessionToolCall } from '../../runtime/sessions/types'
import type { MessageBlock } from '../../shared/session/types'
import { getSystemPromptForMode } from '../../runtime/agent/modePrompt'
import { buildConversationContext } from '../../runtime/agent/contextBuilder'
import { runVerification } from '../../runtime/verification/service'
import { formatVerificationSummary } from '../../runtime/verification/format'

/** 管理 AgentLoop 的生命周期 */
let agentLoop: AgentLoop | null = null

const VERIFICATION_PERMISSION_TIMEOUT_MS = 30_000

interface PendingVerificationPermissionEntry {
  messageId: string
  resolve: (granted: boolean) => void
  timeoutHandle: NodeJS.Timeout
  eventBus: EventBus
}

/** 等待用户对验证权限请求的响应（verificationRequestId → 挂起状态） */
export const pendingVerificationPermissions = new Map<string, PendingVerificationPermissionEntry>()

function clearVerificationPermissionRequest(requestId: string, granted: boolean): void {
  const entry = pendingVerificationPermissions.get(requestId)
  if (!entry) return

  clearTimeout(entry.timeoutHandle)
  pendingVerificationPermissions.delete(requestId)
  entry.resolve(granted)
  entry.eventBus.emit({
    type: 'verification_permission_cleared',
    messageId: entry.messageId,
    requestId
  })
}

function clearAllPendingVerificationPermissions(): void {
  for (const requestId of [...pendingVerificationPermissions.keys()]) {
    clearVerificationPermissionRequest(requestId, false)
  }
}

/**
 * 流式内容累积器
 * 在 message_start 到 message_end 之间累积 assistant 消息的完整内容，
 * 包括文本增量和工具调用记录，用于最终保存到 SessionStore
 */
interface StreamAccumulator {
  content: string
  toolCalls: SessionToolCall[]
  blocks: MessageBlock[]
}

/** 当前正在累积的流式消息映射：messageId → 累积器 */
export const activeStreams = new Map<string, StreamAccumulator>()

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

    const sessionStore = getSessionStore()
    const session = sessionStore.load(params.sessionId)
    if (!session) {
      throw new Error(`会话 ${params.sessionId} 不存在`)
    }

    const projectPath = session.workspaceRoot
    const sessionsDir = sessionStore.getSessionsDir()

    // 在闭包中捕获本次调用的全部上下文，后续所有操作只读这些值
    const capturedSessionId = params.sessionId
    const capturedMode = session.mode
    const capturedWorkspaceRoot = projectPath
    const capturedSessionsDir = sessionsDir

    const eventBus = new EventBus()
    agentLoop = new AgentLoop(modelClient, eventBus, {
      systemPrompt: getSystemPromptForMode(session.mode)
    })

    // 从 session 历史恢复多轮对话上下文（不含 system prompt，由上面 mode 生成）
    const history = buildConversationContext(session, session.mode)
    agentLoop.injectHistory(history)

    agentLoop.setWorkingDir(projectPath)

    const toolRegistry = new ToolRegistry()
    toolRegistry.register(lsTool)
    toolRegistry.register(readTool)
    toolRegistry.register(grepTool)
    toolRegistry.register(findTool)
    toolRegistry.register(editTool)
    toolRegistry.register(writeTool)
    toolRegistry.register(bashTool)
    agentLoop.setToolRegistry(toolRegistry)

    const permissionManager = new PermissionManager()
    agentLoop.setPermissionManager(permissionManager)
    agentLoop.setMode(session.mode)

    const checkpointManager = new CheckpointManager({
      checkpointDir: sessionsDir,
      sessionId: params.sessionId,
      workspaceRoot: projectPath
    })
    agentLoop.setCheckpointManager(checkpointManager)

    const userMessage: SessionMessage = {
      id: `msg_${Date.now()}_user`,
      role: 'user',
      content: params.content,
      timestamp: Date.now()
    }
    sessionStore.appendMessage(params.sessionId, userMessage)

    eventBus.on((event: AgentEvent) => {
      forwardEventToRenderer(getMainWindow(), event)
      accumulateStreamEvent(capturedSessionId, event, {
        mode: capturedMode,
        workspaceRoot: capturedWorkspaceRoot,
        sessionsDir: capturedSessionsDir,
        eventBus,
        getMainWindow
      })
    })

    await agentLoop.sendMessage(params.content)
  })

  ipcMain.handle(CANCEL_EXECUTION, async (): Promise<void> => {
    agentLoop?.cancel()
    clearAllPendingVerificationPermissions()
  })

  ipcMain.handle(RESPOND_PERMISSION, async (_event, params: { requestId: string; decision: PermissionDecision }): Promise<void> => {
    if (!agentLoop) return
    const granted = params.decision === 'allow'
    agentLoop.respondPermission(params.requestId, granted)
  })

  ipcMain.handle(RESPOND_VERIFICATION_PERMISSION, async (_event, params: { requestId: string; granted: boolean }): Promise<void> => {
    clearVerificationPermissionRequest(params.requestId, params.granted)
  })
}

/** 每次消息处理需要的上下文快照，避免读全局变量 */
export interface MessageContext {
  mode: Mode
  workspaceRoot: string
  sessionsDir: string
  eventBus: EventBus
  getMainWindow: () => BrowserWindow | null
}

/**
 * 累积流式事件内容
 */
export function accumulateStreamEvent(sessionId: string, event: AgentEvent, ctx: MessageContext): void {
  switch (event.type) {
    case 'message_start': {
      activeStreams.set(event.messageId, { content: '', toolCalls: [], blocks: [] })
      break
    }
    case 'thinking_delta': {
      const stream = activeStreams.get(event.messageId)
      if (stream) {
        const last = stream.blocks[stream.blocks.length - 1]
        if (last && last.type === 'thinking') {
          last.content += event.delta
        } else {
          stream.blocks.push({ type: 'thinking', content: event.delta })
        }
      }
      break
    }
    case 'text_delta': {
      const stream = activeStreams.get(event.messageId)
      if (stream) {
        stream.content += event.delta
        const last = stream.blocks[stream.blocks.length - 1]
        if (last && last.type === 'text') {
          last.content += event.delta
        } else {
          stream.blocks.push({ type: 'text', content: event.delta })
        }
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
          result: undefined
        })
        stream.blocks.push({
          type: 'tool',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.args,
          status: 'running'
        })
      }
      break
    }
    case 'tool_result': {
      const stream = activeStreams.get(event.messageId)
      if (stream) {
        const isError = event.result.startsWith('工具执行失败') || event.result.startsWith('权限拒绝:')
        const targetIdx = stream.toolCalls.findIndex(tc => tc.id === event.toolCallId)
        if (targetIdx !== -1) {
          stream.toolCalls[targetIdx].result = event.result
        }
        const blockIdx = stream.blocks.findIndex(b => b.type === 'tool' && b.toolCallId === event.toolCallId)
        if (blockIdx !== -1 && stream.blocks[blockIdx].type === 'tool') {
          const block = stream.blocks[blockIdx]
          stream.blocks[blockIdx] = {
            ...block,
            status: isError ? 'error' : 'success',
            result: event.result
          } as typeof block
        }
      }
      emitLiveDiffUpdate(sessionId, event.messageId, ctx)
      break
    }
    case 'message_end': {
      const stream = activeStreams.get(event.messageId)
      if (stream) {
        activeStreams.delete(event.messageId)
        saveAssistantMessage(sessionId, event.messageId, stream.content, stream.toolCalls, stream.blocks)
        triggerVerificationIfNeeded(sessionId, event.messageId, ctx)
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

function emitLiveDiffUpdate(sessionId: string, messageId: string, ctx: MessageContext): void {
  try {
    const nextState = buildMessageDiffState(
      ctx.sessionsDir,
      ctx.workspaceRoot,
      sessionId,
      messageId
    )

    ctx.eventBus.emit({
      type: 'diff_update',
      messageId,
      diffs: nextState.diffs.map(diff => ({
        filePath: diff.filePath,
        status: diff.status
      })),
      reviews: nextState.reviews
    })
  } catch (err) {
    console.error('实时 diff 更新失败:', err)
  }
}

/**
 * 基于 checkpoint manifest 判断本轮是否有真实文件修改
 */
function hasRealModifications(sessionsDir: string, sessionId: string, messageId: string): boolean {
  const manifest = readManifest(sessionsDir, sessionId, messageId)
  if (!manifest) return false
  return (
    manifest.createdFiles.length > 0 ||
    manifest.modifiedFiles.length > 0 ||
    manifest.deletedFiles.length > 0
  )
}

/**
 * 触发验证：所有状态通过参数传入，不依赖全局变量
 */
export function triggerVerificationIfNeeded(
  sessionId: string,
  messageId: string,
  ctx: MessageContext
): void {
  // 基于 checkpoint manifest 判定是否有真实文件修改
  const hasModifications = hasRealModifications(ctx.sessionsDir, sessionId, messageId)
  if (!hasModifications) return

  // 异步执行验证，不阻塞主流程
  // 所有状态已在闭包中捕获，不会因后续操作串线
  const verifyAsync = async () => {
    try {
      const result = await runVerification({
        workingDir: ctx.workspaceRoot,
        mode: ctx.mode,
        hasModifications: true,
        // default 模式：通过 EventBus → IPC 推送到 renderer 等待用户确认
        permissionCallback: async (command: string): Promise<boolean> => {
          const requestId = `vp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          return new Promise<boolean>((resolve) => {
            const timeoutHandle = setTimeout(() => {
              clearVerificationPermissionRequest(requestId, false)
            }, VERIFICATION_PERMISSION_TIMEOUT_MS)

            pendingVerificationPermissions.set(requestId, {
              messageId,
              resolve,
              timeoutHandle,
              eventBus: ctx.eventBus
            })

            ctx.eventBus.emit({
              type: 'verification_permission_request',
              messageId,
              requestId,
              command
            })
          })
        }
      })

      if (!result) return

      const summary = formatVerificationSummary(result)

      ctx.eventBus.emit({
        type: 'verification_result',
        messageId,
        result: summary
      })

      appendVerificationSummary(sessionId, messageId, summary)
    } catch (err) {
      console.error('验证执行失败:', err)
    }
  }

  verifyAsync()
}

/** 将验证摘要追加到已保存的 assistant 消息 */
function appendVerificationSummary(sessionId: string, messageId: string, summary: string): void {
  const sessionStore = getSessionStore()
  const session = sessionStore.load(sessionId)
  if (!session) return

  const msgIndex = session.messages.findIndex(m => m.id === messageId)
  if (msgIndex === -1) return

  session.messages[msgIndex].verificationSummary = summary
  sessionStore.save(session)
}

/** 保存完整的 assistant 消息到会话存储 */
function saveAssistantMessage(
  sessionId: string,
  messageId: string,
  content: string,
  toolCalls: SessionToolCall[],
  blocks: MessageBlock[]
): void {
  const sessionStore = getSessionStore()
  const assistantMessage: SessionMessage = {
    id: messageId,
    role: 'assistant',
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    blocks: blocks.length > 0 ? blocks : undefined,
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
      webContents.send('agent:diff-update', {
        messageId: event.messageId,
        diffs: event.diffs,
        reviews: event.reviews
      })
      break
    case 'verification_result':
      webContents.send('agent:verification-result', { messageId: event.messageId, result: event.result })
      break
    case 'verification_permission_request':
      webContents.send('agent:verification-permission-request', {
        messageId: event.messageId,
        requestId: event.requestId,
        command: event.command
      })
      break
    case 'verification_permission_cleared':
      webContents.send('agent:verification-permission-cleared', {
        messageId: event.messageId,
        requestId: event.requestId
      })
      break
    case 'error':
      webContents.send('agent:error', { messageId: event.messageId, error: event.error })
      break
    case 'message_end':
      webContents.send('agent:message-end', { messageId: event.messageId })
      break
  }
}
