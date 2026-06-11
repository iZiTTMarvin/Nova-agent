/**
 * Agent IPC Handler
 * 连接 renderer 的 IPC 命令和 runtime 的 AgentLoop
 * 将 AgentEvent 通过 IPC 推送到 renderer
 * S9：集成 CheckpointManager、SessionStore、流式内容累积
 */
import { ipcMain, BrowserWindow } from 'electron'
import { SEND_MESSAGE, CANCEL_EXECUTION, RESPOND_PERMISSION, RESPOND_VERIFICATION_PERMISSION, LIST_SKILLS } from '../../shared/ipc/channels'
import { app } from 'electron'
import { join } from 'path'
import { AgentLoop } from '../../runtime/agent/AgentLoop'
import { loadModelConfig } from '../../runtime/model/config'
import { inferContextWindow, inferVisionSupport } from '../../shared/config/types'
import { randomUUID } from 'crypto'
import { EventBus } from '../../runtime/agent/EventBus'
import { ToolRegistry } from '../../runtime/tools/ToolRegistry'
import { lsTool } from '../../runtime/tools/lsTool'
import { readTool } from '../../runtime/tools/readTool'
import { createGrepTool } from '../../runtime/tools/grepTool'
import { findTool } from '../../runtime/tools/findTool'
import { editTool } from '../../runtime/tools/editTool'
import { writeTool } from '../../runtime/tools/writeTool'
import { bashTool } from '../../runtime/tools/bashTool'
import { todoWriteTool } from '../../runtime/tools/todoWriteTool'
import { PermissionManager } from '../../runtime/permissions/PermissionManager'
import { CheckpointManager } from '../../runtime/checkpoints/CheckpointManager'
import { readManifest } from '../../runtime/checkpoints/manifest'
import type { ModelClient } from '../../runtime/model/ModelClient'
import type { AgentEvent } from '../../runtime/agent/types'
import type { RecoveryState } from '../../runtime/agent/RecoveryStateMachine'
import type { RendererRecoveryState } from '../../shared/ipc/types'
import type { Mode, PermissionDecision } from '../../shared/session/types'
import { getSessionStore } from './sessionHandler'
import type { SessionMessage, SessionToolCall, SerializableContentBlock } from '../../runtime/sessions/types'
import { extractTextFromSerializableContent } from '../../runtime/sessions/types'
import type { MessageBlock } from '../../shared/session/types'
import { getStableSystemPrompt } from '../../runtime/agent/modePrompt'
import { buildConversationContext } from '../../runtime/agent/contextBuilder'
import { SkillRegistry } from '../../runtime/skills/SkillRegistry'
import { buildSkillContext } from '../../runtime/agent/buildSkillContext'
import { discoverProjectRules } from '../../runtime/agent/projectRulesDiscovery'
import { createInvokeSkillTool } from '../../runtime/tools/invokeSkillTool'
import { createTaskTool } from '../../runtime/tools/taskTool'
import { defaultSubAgentPermissionBridge } from '../../runtime/tools/subAgentBridge'
import type { ContentBlock } from '../../runtime/model/types'
import { runVerification } from '../../runtime/verification/service'
import { formatVerificationSummary } from '../../runtime/verification/format'

/** 管理 AgentLoop 的生命周期 */
let agentLoop: AgentLoop | null = null

/** 缓存用户可 slash 调用的技能（供 renderer datalist） */
let cachedUserInvocableSkills: Array<{ name: string; description: string }> = []

/**
 * 展开 slash 命令为自然语言提示（命中 user-invocable 技能）。
 * 第一版不强制 tool_call，由 LLM 根据提示主动调用 invoke_skill。
 */
function expandSlashCommand(content: string, registry: SkillRegistry): string {
  if (!content.startsWith('/')) return content
  const match = content.match(/^\/([^\s]+)(?:\s+(.*))?$/)
  if (!match) return content
  const [, skillName, rest] = match
  const skill = registry.get(skillName ?? '')
  if (!skill?.userInvocable) return content
  return `请使用 invoke_skill 工具调用技能「${skill.name}」，任务：${rest?.trim() || '按技能说明执行'}`
}

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
  /**
   * 是否在累积过程中被取消。
   * 一旦置为 true，message_end 时持久化层会剔除"权限拒绝: 用户拒绝"等
   * 由 cancel 路径残留的 tool block，避免历史回放出现莫名其妙的拒绝卡片。
   * 这是兜底保险——理论上 runtime 层（AgentLoop）已不再产生该残留。
   */
  cancelled?: boolean
}

/** 当前正在累积的流式消息映射：messageId → 累积器 */
export const activeStreams = new Map<string, StreamAccumulator>()

/** 把所有 active stream 标记为 cancelled，供 message_end 路径做兜底过滤 */
export function markActiveStreamsCancelled(): void {
  for (const stream of activeStreams.values()) {
    stream.cancelled = true
  }
}

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
  ipcMain.handle(SEND_MESSAGE, async (_event, params: { sessionId: string; content: string; images?: Array<{ fileName: string; data: string; mimeType: string }> }): Promise<void> => {
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

    // 使用会话级冻结的 system prompt，保证前缀稳定（缓存 Harness 核心）
    const frozenPrompt = session.frozenSystemPrompt ?? getStableSystemPrompt()

    // 如果旧会话还没有冻结的 prompt，回写一份
    if (!session.frozenSystemPrompt) {
      session.frozenSystemPrompt = frozenPrompt
      sessionStore.save(session)
    }

    // 读取持久化配置以获取模型上下文窗口上限，用于动态压缩阈值
    const persistedConfig = loadModelConfig(app.getPath('userData'))
    const contextWindow = persistedConfig?.contextWindow ?? inferContextWindow(persistedConfig?.modelId ?? '')
    const supportsVision = persistedConfig?.supportsVision ?? inferVisionSupport(persistedConfig?.modelId ?? '')

    const skillRegistry = SkillRegistry.load({
      projectDir: join(projectPath, '.nova', 'skills')
    })
    cachedUserInvocableSkills = skillRegistry.listUserInvocable().map(s => ({
      name: s.name,
      description: s.description
    }))

    const projectRules = discoverProjectRules(projectPath)
    const skillContext = buildSkillContext(skillRegistry.listForContext())

    const eventBus = new EventBus()
    const permissionManager = new PermissionManager()

    const toolRegistry = new ToolRegistry()
    toolRegistry.register(lsTool)
    toolRegistry.register(readTool)
    toolRegistry.register(createGrepTool({ maxResultSizeChars: 100_000 }))
    toolRegistry.register(findTool)
    toolRegistry.register(editTool)
    toolRegistry.register(writeTool)
    toolRegistry.register(bashTool)
    toolRegistry.register(todoWriteTool)
    toolRegistry.register(createInvokeSkillTool({ modelClient, skillRegistry }))

    const toolSummary = toolRegistry.getToolDefinitions()
      .map(t => `- ${t.name}: ${t.description.split('\n')[0]}`)
      .join('\n')

    agentLoop = new AgentLoop(modelClient, eventBus, {
      systemPromptLayers: {
        agentRole: frozenPrompt,
        projectRules,
        skillContext,
        toolSummary
      },
      contextWindow,
      supportsVision,
      onCompaction: (compactedContext) => {
        // 将压缩后的上下文写回 session，保证跨轮次持久化
        const compactedSession = sessionStore.load(params.sessionId)
        if (!compactedSession) return

        const compactedMessages: SessionMessage[] = compactedContext
          .filter(m => m.role !== 'system')
          .map((m, idx) => ({
            id: `compacted_${randomUUID().slice(0, 8)}_${idx}`,
            role: m.role as SessionMessage['role'],
            content: extractTextFromSerializableContent(m.content),
            toolCalls: m.toolCalls?.map(tc => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
              result: undefined
            })),
            toolCallId: m.toolCallId,
            timestamp: Date.now()
          }))

        compactedSession.messages = compactedMessages
        sessionStore.save(compactedSession)
      }
    })

    // 从 session 历史恢复多轮对话上下文
    const history = buildConversationContext(session, session.mode)
    agentLoop.injectHistory(history)

    toolRegistry.register(createTaskTool({
      modelClient,
      parentEventBus: eventBus,
      contextWindow,
      supportsVision,
      resolveTool: (name) => toolRegistry.getTool(name)
    }))

    agentLoop.setToolRegistry(toolRegistry)
    agentLoop.getHookManager().on('onMessageStart', (payload) => {
      console.log(`[Hook] onMessageStart messageId=${payload.messageId}`)
    })

    agentLoop.setWorkingDir(projectPath)
    // 把 bash 工具的执行环境（shellPath / binDirs）注入到 AgentLoop。
    // 暂时只把项目 node_modules/.bin 加到 PATH——shellPath 没有用户配置时
    // 保留 undefined，让 bash 工具按平台自动发现（pwsh / powershell / Git Bash / cmd）。
    agentLoop.setBashEnvironment({
      binDirs: [join(projectPath, 'node_modules', '.bin')]
    })

    agentLoop.setPermissionManager(permissionManager)
    agentLoop.setMode(session.mode)
    // 注入会话上下文：todo_write 工具通过它写会话元数据
    agentLoop.setSessionContext(sessionStore, params.sessionId)

    const checkpointManager = new CheckpointManager({
      checkpointDir: sessionsDir,
      sessionId: params.sessionId,
      workspaceRoot: projectPath
    })
    agentLoop.setCheckpointManager(checkpointManager)

    // 构建用户消息内容（含图片时为 ContentBlock[]，否则为 string）
    // modeInstruction 统一由 AgentLoop.sendMessage 追加，持久化中不包含
    let sendContent: string | ContentBlock[]
    let persistContent: string | SerializableContentBlock[]
    const persistBlocks: import('../../shared/session/types').MessageBlock[] = []

    if (params.images && params.images.length > 0) {
      const imageContentBlocks: ContentBlock[] = [
        { type: 'text', text: params.content },
        ...params.images.map(img => ({
          type: 'image_url' as const,
          image_url: { url: img.data }
        }))
      ]
      // ContentBlock 与 SerializableContentBlock 结构兼容，复用同一数组
      sendContent = imageContentBlocks
      persistContent = imageContentBlocks as SerializableContentBlock[]
      persistBlocks.push({ type: 'text', content: params.content })
      persistBlocks.push(...params.images.map(img => ({
        type: 'image' as const,
        fileName: img.fileName,
        dataUrl: img.data,
        mimeType: img.mimeType
      })))
    } else {
      sendContent = expandSlashCommand(params.content, skillRegistry)
      persistContent = params.content
    }

    const userMessage: SessionMessage = {
      id: `msg_${Date.now()}_user`,
      role: 'user',
      content: persistContent,
      blocks: persistBlocks.length > 0 ? persistBlocks : undefined,
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

    await agentLoop.sendMessage(sendContent)
  })

  ipcMain.handle(LIST_SKILLS, async (): Promise<Array<{ name: string; description: string }>> => {
    return cachedUserInvocableSkills
  })

  ipcMain.handle(CANCEL_EXECUTION, async (): Promise<void> => {
    agentLoop?.cancel()
    defaultSubAgentPermissionBridge.clear()
    markActiveStreamsCancelled()
    clearAllPendingVerificationPermissions()
  })

  ipcMain.handle(RESPOND_PERMISSION, async (_event, params: { requestId: string; decision: PermissionDecision }): Promise<void> => {
    const granted = params.decision === 'allow'
    // 子代理权限（sub: 前缀）路由到子 AgentLoop，其余走父循环
    if (defaultSubAgentPermissionBridge.resolve(params.requestId, granted)) return
    if (!agentLoop) return
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
  // 注意：tool_call_start / tool_call_delta 是流式增量事件，不写 stream 累积器。
  // 持久化只关心最终完整 tool_call（由 tool_call 事件写入），增量不落盘。
  switch (event.type) {
    case 'message_start': {
      activeStreams.set(event.messageId, { content: '', toolCalls: [], blocks: [], cancelled: false })
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
      // 异步调度：让 tool_result 当前的 EventBus 调用栈（含其他订阅者、IPC 转发）
      // 先全部跑完，避免 manifest 读盘阻塞下一个 thinking_delta 的处理。
      scheduleLiveDiffUpdate(sessionId, event.messageId, ctx)
      break
    }
    case 'message_end': {
      const stream = activeStreams.get(event.messageId)
      if (stream) {
        activeStreams.delete(event.messageId)

        // T3-3 兜底：cancel 期间残留的"权限拒绝"工具结果不应进入持久化历史，
        // 否则下次进入会话会看到莫名其妙的拒绝卡片。
        const { toolCalls, blocks } = stream.cancelled
          ? dropPermissionDeniedResiduals(stream.toolCalls, stream.blocks)
          : { toolCalls: stream.toolCalls, blocks: stream.blocks }

        saveAssistantMessage(sessionId, event.messageId, stream.content, toolCalls, blocks, event.interrupted)
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

/**
 * 工具执行完成后实时点亮前端的占位信号
 *
 * 只读 checkpoint manifest 的文件清单，不计算 LCS（重活留给 message_end 后的
 * get-message-diffs 路径，避免在事件循环里阻塞。Renderer 收到 phase: 'live'
 * 会进入 loading skeleton 状态，不渲染 +X -Y 中间值。
 *
 * 竞态保护：本函数被 setImmediate 异步调度。若在排队期间 message_end 已经
 * 把累积器从 activeStreams 删除，说明 renderer 这边的 loadMessageDiffs 已经
 * 拿到 final 数据写入了 messageDiffs；此时再 emit 一个 live 占位会把真实
 * 数据压回骨架，且没有后续 final 来恢复。直接跳过即可。
 */
function emitLiveDiffUpdate(sessionId: string, messageId: string, ctx: MessageContext): void {
  if (!activeStreams.has(messageId)) return

  try {
    const manifest = readManifest(ctx.sessionsDir, sessionId, messageId)
    if (!manifest || manifest.status !== 'active') return

    const reviews = manifest.fileReviews ?? {}
    const liveDiffs: Array<{ filePath: string; status: 'added' | 'modified' | 'deleted' }> = [
      ...manifest.modifiedFiles.map(filePath => ({ filePath, status: 'modified' as const })),
      ...manifest.createdFiles.map(filePath => ({ filePath, status: 'added' as const })),
      ...manifest.deletedFiles.map(filePath => ({ filePath, status: 'deleted' as const }))
    ]

    if (liveDiffs.length === 0) return

    ctx.eventBus.emit({
      type: 'diff_update',
      messageId,
      phase: 'live',
      diffs: liveDiffs,
      reviews
    })
  } catch (err) {
    console.error('实时 diff 占位更新失败:', err)
  }
}

/**
 * 异步调度 emitLiveDiffUpdate。
 *
 * 用 setImmediate 把 manifest 读盘 + emit 推到下一个事件循环 tick，让 tool_result
 * 当前的 EventBus 监听器链（forwardEventToRenderer、本累积器等）先全部跑完。
 * 这样后续 thinking_delta 不会被 IO/emit 同步阻塞。
 *
 * 同时埋点 tool_result → diff_update 之间的间隔，便于排查阻塞回归。
 */
function scheduleLiveDiffUpdate(sessionId: string, messageId: string, ctx: MessageContext): void {
  const t0 = performance.now()
  setImmediate(() => {
    emitLiveDiffUpdate(sessionId, messageId, ctx)
    const dt = performance.now() - t0
    if (dt > 50) {
      console.warn(`[perf] tool_result → diff_update: ${dt.toFixed(1)}ms (>50ms)`)
    } else {
      console.debug(`[perf] tool_result → diff_update: ${dt.toFixed(1)}ms`)
    }
  })
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
  blocks: MessageBlock[],
  interrupted?: boolean
): void {
  const sessionStore = getSessionStore()
  const assistantMessage: SessionMessage = {
    id: messageId,
    role: 'assistant',
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    blocks: blocks.length > 0 ? blocks : undefined,
    timestamp: Date.now(),
    // 取消中断的消息也持久化 interrupted 标记，下次加载时 UI 仍能区分
    ...(interrupted ? { interrupted: true } : {})
  }
  sessionStore.appendMessage(sessionId, assistantMessage)
}

/**
 * 兜底过滤：剔除"权限拒绝: 用户拒绝"残留
 *
 * 当 cancel 在权限弹窗弹出时被触发，理论上 AgentLoop 已经走 PermissionAbortedError
 * 路径不再发出 tool_result 事件；但这里再做一道兜底，让旧版本 runtime 或异常路径
 * 也不会污染会话历史。
 *
 * 只剔除"由用户拒绝产生"的权限拒绝条目（reason 含「用户拒绝」），保留模式策略
 * 引发的拒绝（如 plan 模式拒写工具），后者是 Agent 真实经历过的事实。
 */
function dropPermissionDeniedResiduals(
  toolCalls: SessionToolCall[],
  blocks: MessageBlock[]
): { toolCalls: SessionToolCall[]; blocks: MessageBlock[] } {
  const isUserDenied = (result?: string): boolean =>
    typeof result === 'string' && result.startsWith('权限拒绝:') && result.includes('用户拒绝')

  const droppedIds = new Set<string>()
  for (const tc of toolCalls) {
    if (isUserDenied(tc.result)) droppedIds.add(tc.id)
  }
  if (droppedIds.size === 0) {
    return { toolCalls, blocks }
  }

  return {
    toolCalls: toolCalls.filter(tc => !droppedIds.has(tc.id)),
    blocks: blocks.filter(b => b.type !== 'tool' || !droppedIds.has(b.toolCallId))
  }
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

/** 截断 recovering.snapshot，只向渲染端发送 UI 所需字段 */
function toRendererRecoveryState(state: RecoveryState): RendererRecoveryState {
  switch (state.kind) {
    case 'continuing':
      return { kind: 'continuing' }
    case 'retrying':
      return {
        kind: 'retrying',
        attempt: state.attempt,
        lastError: state.lastError,
        maxAttempts: state.maxAttempts
      }
    case 'recovering':
      return { kind: 'recovering', fromMessageId: state.fromMessageId }
    case 'failed':
      return { kind: 'failed', error: state.error }
  }
}

/** 将 AgentEvent 映射到 IPC 事件 channel 并推送到 renderer */
export function forwardEventToRenderer(
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
    case 'tool_call_start':
      webContents.send('agent:tool-call-start', { messageId: event.messageId, toolCallId: event.toolCallId, toolName: event.toolName })
      break
    case 'tool_call_delta':
      webContents.send('agent:tool-call-delta', { messageId: event.messageId, toolCallId: event.toolCallId, argumentsDelta: event.argumentsDelta })
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
        phase: event.phase,
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
    case 'todos_updated':
      webContents.send('agent:todos-updated', {
        sessionId: event.sessionId,
        todos: event.todos,
        view: event.view
      })
      break
    case 'usage':
      webContents.send('agent:usage', { messageId: event.messageId, usage: event.usage })
      break
    case 'cache_diagnostic':
      webContents.send('agent:cache-diagnostic', { messageId: event.messageId, diagnostic: event.diagnostic })
      break
    case 'error':
      webContents.send('agent:error', { messageId: event.messageId, error: event.error })
      break
    case 'hook_error':
      webContents.send('agent:hook-error', {
        messageId: event.messageId,
        hookEvent: event.hookEvent,
        error: event.error
      })
      break
    case 'recovery_hint':
      webContents.send('agent:recovery-hint', {
        messageId: event.messageId,
        hint: event.hint,
        attempt: event.attempt
      })
      break
    case 'recovery_state':
      webContents.send('agent:recovery-state', {
        messageId: event.messageId,
        state: toRendererRecoveryState(event.state)
      })
      break
    case 'message_end':
      webContents.send('agent:message-end', {
        messageId: event.messageId,
        ...(event.interrupted ? { interrupted: true } : {})
      })
      break
  }
}
