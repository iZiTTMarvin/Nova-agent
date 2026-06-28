/**
 * Agent IPC Handler
 * 连接 renderer 的 IPC 命令和 runtime 的 AgentLoop
 * 将 AgentEvent 通过 IPC 推送到 renderer
 * S9：集成 CheckpointManager、SessionStore、流式内容累积
 */
import { ipcMain, BrowserWindow } from 'electron'
import { SEND_MESSAGE, CANCEL_EXECUTION, RESPOND_PERMISSION, RESPOND_VERIFICATION_PERMISSION } from '../../shared/ipc/channels'
import { app } from 'electron'
import { join } from 'path'
import { AgentLoop, EventBus, renderToolInventory, buildStableSystemPrompt, normalizeFrozenSystemPrompt, buildSkillContext, estimateTokens, discoverProjectRules, renderBaseRules, type AgentEvent, type RecoveryState } from '../../runtime/agent'
import { loadModelConfig } from '../../runtime/model/config'
import { inferContextWindow, inferVisionSupport, inferCacheStrategy } from '../../shared/config/types'
import { preferredToolDialect } from '../../runtime/model/dialect'
import { OpenAICompatibleModelClient } from '../../runtime/model/OpenAICompatibleModelClient'
import { ModelClientPool } from '../../runtime/model/ModelClientPool'
import { ToolRegistry } from '../../runtime/tools/ToolRegistry'
import { lsTool } from '../../runtime/tools/lsTool'
import { readTool } from '../../runtime/tools/readTool'
import { createGrepTool } from '../../runtime/tools/grepTool'
import { findTool } from '../../runtime/tools/findTool'
import { webSearchTool } from '../../runtime/tools/webSearch'
import { editTool } from '../../runtime/tools/editTool'
import { writeTool } from '../../runtime/tools/writeTool'
import { bashTool } from '../../runtime/tools/bashTool'
import { todoWriteTool } from '../../runtime/tools/todoWriteTool'
import { PermissionManager } from '../../runtime/permissions/PermissionManager'
import { listPermissionRules } from '../../runtime/permissions/PermissionService'
import { CheckpointManager } from '../../runtime/checkpoints/CheckpointManager'
import { readManifest } from '../../runtime/checkpoints/manifest'
import type { ModelClient } from '../../runtime/model/ModelClient'
import type { RendererRecoveryState } from '../../shared/ipc/types'
import type { Mode, PermissionDecision } from '../../shared/session/types'
import { getSessionStore } from './sessionHandler'
import type { SessionMessage, SessionToolCall, SerializableContentBlock } from '../../runtime/sessions/types'
import type { MessageBlock } from '../../shared/session/types'
import {
  persistCompactionSnapshot,
  restoreOrInjectHistory
} from '../../runtime/sessions/contextSnapshot'
import { getSkillService } from '../services/SkillServiceHost'
import { createInvokeSkillTool } from '../../runtime/tools/invokeSkillTool'
import { createTaskTool } from '../../runtime/tools/taskTool'
import { defaultSubAgentPermissionBridge } from '../../runtime/tools/subAgentBridge'
import { createReadState, type ReadState } from '../../runtime/tools/editTool'
import { createEventStallDetector } from '../../shared/diagnostics/stallDetector'
import { ArtifactStore } from '../../runtime/artifacts/ArtifactStore'
import type { ContentBlock } from '../../runtime/model/types'
import { runVerification } from '../../runtime/verification/service'
import { formatVerificationSummary } from '../../runtime/verification/format'
import { loadNovaSettings } from '../../runtime/settings/novaSettings'
import { syncTavilyApiKeyFromSettings } from '../../runtime/settings/syncTavilyApiKey'

/** 管理 AgentLoop 的生命周期 */
let agentLoop: AgentLoop | null = null

/**
 * 主 readState：跨多次 SEND_MESSAGE 复用，记录"模型已读过的文件"。
 *
 * 每次新建 AgentLoop 时通过 setReadState 注入，使得同一会话连发多条消息时
 * 第二条消息能继续享受第一条消息的 read 状态（否则 edit 会陷入
 * "File has not been read yet" 循环）。
 *
 * Sub agent（task / skill fork）通过 cloneReadState 拿深拷贝，不污染此实例。
 * 会话切换 / 创建 / 回退时由 sessionHandler 显式 clear。
 */
const mainReadState: ReadState = createReadState()

/** 暴露给 sessionHandler：会话切换/创建/回退时清空 readState，避免跨会话污染 */
export function getMainReadState(): ReadState {
  return mainReadState
}

const VERIFICATION_PERMISSION_TIMEOUT_MS = 30_000

/** 统一 skill 调度开关（默认开启；测试可经环境变量关闭） */
const USE_UNIFIED_SKILL_DISPATCH = process.env.NOVA_USE_UNIFIED_SKILL_DISPATCH !== 'false'

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
 * PRD §5.4：为主 modelClient 构建 ModelClientPool。
 * - 读取磁盘 ModelConfig，若有 fallbacks 则为每个 fallback 创建 client 并组装 pool。
 * - 无 fallbacks 时返回单个 client（AgentLoop 构造函数会自动包装成无 fallback 的 pool）。
 * - fallback client 创建失败（配置非法）时跳过该条，不阻塞主流程。
 */
function buildModelPoolWithFallbacks(primary: ModelClient): ModelClient | ModelClientPool {
  try {
    const cfg = loadModelConfig(app.getPath('userData'))
    if (!cfg || !cfg.fallbacks || cfg.fallbacks.length === 0) {
      return primary
    }

    const fallbackSlots: Array<{ config: typeof cfg; client: OpenAICompatibleModelClient }> = []
    for (const fb of cfg.fallbacks) {
      try {
        if (!fb.baseUrl || !fb.apiKey || !fb.modelId) continue
        const fbClient = new OpenAICompatibleModelClient(fb)
        if (!fb.cacheStrategy) {
          fbClient.setCacheStrategy(inferCacheStrategy(fb.baseUrl))
        }
        fallbackSlots.push({ config: fb, client: fbClient })
      } catch (err) {
        console.error('[agentHandler] 创建 fallback client 失败，已跳过:', err)
      }
    }

    if (fallbackSlots.length === 0) return primary

    return new ModelClientPool({
      primary,
      primaryConfig: cfg,
      fallbacks: fallbackSlots.map(s => ({ config: s.config, client: s.client }))
    })
  } catch (err) {
    console.error('[agentHandler] 构建 fallback pool 失败，回退单 client:', err)
    return primary
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
    const artifactStore = new ArtifactStore(sessionsDir)

    // 读取持久化配置以获取模型上下文窗口上限，用于动态压缩阈值
    const persistedConfig = loadModelConfig(app.getPath('userData'))
    const contextWindow = persistedConfig?.contextWindow ?? inferContextWindow(persistedConfig?.modelId ?? '')
    const supportsVision = persistedConfig?.supportsVision ?? inferVisionSupport(persistedConfig?.modelId ?? '')
    const novaSettings = loadNovaSettings()
    syncTavilyApiKeyFromSettings()

    const skillService = getSkillService()
    if (skillService.getWorkspaceRoot() !== projectPath) {
      skillService.load(projectPath)
    }
    const skillRegistry = skillService.getRegistry()

    const projectRules = discoverProjectRules(projectPath)?.text ?? ''
    /** 行为契约层：模板化 base rules，与模式指令（挂 user 尾部）分离以保缓存前缀稳定 */
    const baseRules = renderBaseRules()
    const skillContext = buildSkillContext(skillRegistry.listForContext())
    /** 技能正文独立 token 估算(传入 AgentLoop,作为"技能"分项桶) */
    const skillsTokenEstimate = estimateTokens(skillContext)

    const eventBus = new EventBus()
    const permissionManager = new PermissionManager()
    // PRD §5.2：注入持久化权限规则 + 当前项目路径，用于匹配 allow/deny/ask
    permissionManager.setRules(listPermissionRules(projectPath))
    permissionManager.setCurrentProjectPath(projectPath)
    permissionManager.setSessionId(params.sessionId)

    const toolRegistry = new ToolRegistry()
    toolRegistry.register(lsTool)
    toolRegistry.register(readTool)
    toolRegistry.register(createGrepTool({ maxResultSizeChars: 100_000 }))
    toolRegistry.register(findTool)
    toolRegistry.register(webSearchTool)
    toolRegistry.register(editTool)
    toolRegistry.register(writeTool)
    toolRegistry.register(bashTool)
    toolRegistry.register(todoWriteTool)
    toolRegistry.register(createInvokeSkillTool({
      modelClient,
      skillRegistry,
      useUnifiedSkillDispatch: USE_UNIFIED_SKILL_DISPATCH,
      parentEventBus: eventBus,
      resolveTool: (name) => toolRegistry.getTool(name),
      contextWindow,
      supportsVision
    }))

    // PRD §5.4：构建带 fallback 的 ModelClientPool（若配置了 fallbacks）
    const modelPool = buildModelPoolWithFallbacks(modelClient)
    const activeProvider = modelPool instanceof ModelClientPool
      ? modelPool.getActiveProvider()
      : {
        modelId: persistedConfig?.modelId ?? '',
        baseUrl: persistedConfig?.baseUrl ?? '',
        toolDialect: persistedConfig?.toolDialect
      }
    const toolDialect = preferredToolDialect(
      activeProvider.modelId,
      activeProvider.baseUrl,
      persistedConfig?.toolDialect ?? activeProvider.toolDialect
    )
    const toolSummary = renderToolInventory(toolRegistry.getToolDefinitions(), { dialect: toolDialect })

    // system prompt 角色层使用新的 buildStableSystemPrompt，它内部会根据方言
    // 生成合适的工具目录格式。旧的 frozenPrompt（纯字符串）仅在 layers 不存在时兜底。
    // agentRole 层不含工具目录；XML/native 工具说明统一走 toolSummary 层，避免重复占 token。
    const frozenPrompt = buildStableSystemPrompt({
      workingDir: projectPath
    })

    // 如果旧会话还没有冻结 prompt，或命中了已知旧版错误 prompt，则回写一份当前稳定版本。
    if (session.frozenSystemPrompt !== frozenPrompt) {
      session.frozenSystemPrompt = frozenPrompt
      sessionStore.save(session)
    }

    // 创建新 loop 前先释放旧 loop 的资源（I3）：
    // 旧 loop 即使本轮已结束，idleTimer（266 秒后台压缩）仍在运行，
    // 且 pending permissions 可能持有未决 promise。dispose 会一并清理。
    if (agentLoop) {
      agentLoop.dispose()
    }

    agentLoop = new AgentLoop(modelPool, eventBus, {
      systemPromptLayers: {
        agentRole: frozenPrompt,
        baseRules,
        projectRules,
        skillContext,
        toolSummary
      },
      skillsTokenEstimate,
      useUnifiedSkillDispatch: USE_UNIFIED_SKILL_DISPATCH,
      contextWindow,
      supportsVision,
      maxToolRounds: novaSettings.maxToolRounds,
      toolDialectOverride: persistedConfig?.toolDialect,
      onCompaction: (compactedContext, meta) => {
        if (!persistCompactionSnapshot(sessionStore, capturedSessionId, compactedContext, meta)) {
          console.error(`[onCompaction] 找不到会话 ${capturedSessionId}，快照未写`)
        }
      }
    })

    agentLoop.setWorkingDir(projectPath)
    // PRD §5.1：把工具注册表注入 AgentLoop
    agentLoop.setToolRegistry(toolRegistry)
    // 把 bash 工具的执行环境（shellPath / binDirs）注入到 AgentLoop。
    // 暂时只把项目 node_modules/.bin 加到 PATH——shellPath 没有用户配置时
    // 保留 undefined，让 bash 工具按平台自动发现（pwsh / powershell / Git Bash / cmd）。
    agentLoop.setBashEnvironment({
      binDirs: [join(projectPath, 'node_modules', '.bin')]
    })

    agentLoop.setPermissionManager(permissionManager)
    agentLoop.setMode(session.mode)
    // 注入会话上下文：todo_write 工具通过它写会话元数据
    // 必须在 injectHistory 之前设置 sessionId，否则恢复历史后触发的
    // context_breakdown 事件会带上空 sessionId。
    agentLoop.setSessionContext(sessionStore, params.sessionId)
    agentLoop.setArtifactStore(artifactStore)
    // 注入主 readState：跨多次 SEND_MESSAGE 复用，使得同一会话连发消息时
    // 第二条消息能继续享受第一条消息的 read 状态（I1 实例化）
    agentLoop.setReadState(mainReadState)

    // 从 session 历史恢复多轮对话上下文（快照优先 + 增量补齐，锚点失效则全量重建）
    restoreOrInjectHistory(
      agentLoop,
      session,
      sessionStore.loadContextSnapshot(params.sessionId)
    )

    toolRegistry.register(createTaskTool({
      modelClient,
      parentEventBus: eventBus,
      contextWindow,
      supportsVision,
      resolveTool: (name) => toolRegistry.getTool(name)
    }))

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
      // slash 调度由 AgentLoop.invokeSkill 处理；持久化保留用户原始输入
      sendContent = params.content
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

    // 常驻黑匣子：主进程事件间隔 stall 检测，定位偶发卡顿时用。
    // 设 NOVA_STALL_DEBUG=0 可静默。详见 shared/diagnostics/stallDetector.ts
    const stallMark = createEventStallDetector()

    eventBus.on((event: AgentEvent) => {
      stallMark(event.type)
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

  ipcMain.handle(CANCEL_EXECUTION, async (): Promise<void> => {
    // 先停父 agent，再联动停所有活跃子代理。
    // 顺序：父先 cancel 可避免父在子停止后又派新的工具调用；子 cancel 后父的
    // await subLoop.sendMessage(task) 才会在最近的 abort 检查点返回。
    agentLoop?.cancel()
    defaultSubAgentPermissionBridge.cancelAll()
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
          if (event.artifactId) {
            stream.toolCalls[targetIdx].artifactId = event.artifactId
          }
          if (event.truncationMeta) {
            stream.toolCalls[targetIdx].truncationMeta = event.truncationMeta
          }
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
      webContents.send('agent:tool-result', {
        messageId: event.messageId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        ...(event.artifactId ? { artifactId: event.artifactId } : {}),
        ...(event.truncationMeta ? { truncationMeta: event.truncationMeta } : {})
      })
      break
    case 'permission_request':
      webContents.send('agent:permission-request', {
        messageId: event.messageId,
        requestId: event.requestId,
        toolName: event.toolName,
        args: event.args,
        riskLevel: event.riskLevel,
        reason: event.reason,
        commands: event.commands,
        toolCallIds: event.toolCallIds
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
    case 'context_breakdown':
      webContents.send('agent:context-breakdown', {
        sessionId: event.sessionId,
        messageId: event.messageId,
        breakdown: event.breakdown,
        totalEstimated: event.totalEstimated,
        promptTokensActual: event.promptTokensActual,
        capturedAt: event.capturedAt
      })
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
    case 'model_switched':
      webContents.send('agent:model-switched', {
        messageId: event.messageId,
        modelId: event.modelId,
        fallbackIndex: event.fallbackIndex,
        reason: event.reason
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
