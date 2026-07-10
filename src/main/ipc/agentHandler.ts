/**
 * Agent IPC Handler
 * 连接 renderer 的 IPC 命令和 runtime 的 AgentLoop
 * 将 AgentEvent 通过 IPC 推送到 renderer
 * S9：集成 CheckpointManager、SessionStore、流式内容累积
 */
import { BrowserWindow, app } from 'electron'
import * as fs from 'fs'
import { handle } from './secureIpc'
import { SEND_MESSAGE, CANCEL_EXECUTION, RESPOND_PERMISSION, RESPOND_VERIFICATION_PERMISSION, RESPOND_ASK_QUESTION } from '../../shared/ipc/channels'
import { join } from 'path'
import { AgentLoop, EventBus, renderToolInventory, buildStableSystemPrompt, normalizeFrozenSystemPrompt, buildSkillContextForMode, estimateTokens, discoverProjectRules, renderBaseRules, type AgentEvent, type RecoveryState } from '../../runtime/agent'
import { runWorkflow } from '../../runtime/workflow'
import { loadModelConfig } from '../../runtime/model/config'
import { inferContextWindow, resolveSupportsVision, inferCacheStrategy } from '../../shared/config/types'
import { preferredToolDialect } from '../../runtime/model/dialect'
import { OpenAICompatibleModelClient } from '../../runtime/model/OpenAICompatibleModelClient'
import { ModelClientPool } from '../../runtime/model/ModelClientPool'
import { ToolRegistry } from '../../runtime/tools/ToolRegistry'
import { lsTool } from '../../runtime/tools/lsTool'
import { readTool } from '../../runtime/tools/readTool'
import { createGrepTool } from '../../runtime/tools/grepTool'
import { findTool } from '../../runtime/tools/findTool'
import { webSearchTool } from '../../runtime/tools/webSearch'
import { createMemorySearchTool } from '../../runtime/tools/memorySearch'
import { editTool } from '../../runtime/tools/editTool'
import { writeTool } from '../../runtime/tools/writeTool'
import { bashTool } from '../../runtime/tools/bashTool'
import { todoWriteTool } from '../../runtime/tools/todoWriteTool'
import { askQuestionTool } from '../../runtime/tools/askQuestionTool'
import { PermissionManager } from '../../runtime/permissions/PermissionManager'
import { listPermissionRules } from '../../runtime/permissions/PermissionService'
import { CheckpointManager } from '../../runtime/checkpoints/CheckpointManager'
import { readManifest } from '../../runtime/checkpoints/manifest'
import type { ModelClient } from '../../runtime/model/ModelClient'
import type { RendererRecoveryState } from '../../shared/ipc/types'
import type { AskQuestionItem, AskQuestionAnswer } from '../../shared/askQuestion/types'
import type { Mode, PermissionDecision } from '../../shared/session/types'
import { getSessionStore } from './sessionHandler'
import type { SessionMessageAppend, SerializableContentBlock } from '../../runtime/sessions/types'
import { extractTextFromSerializableContent, generateSessionTitleFromText } from '../../runtime/sessions/types'
import { getSessionActiveMessages } from '../../runtime/sessions/tree'
import { projectAssistantFieldsFromBlocks, MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE } from '../../runtime/sessions/messageProjection'
import type { MessageBlock } from '../../shared/session/types'
import { ImageStore } from '../../runtime/storage/ImageStore'
import { getWorkspaceService } from '../services/WorkspaceService'
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
import {
  flushMainDeltaCoalescer,
  pushMainTextDelta,
  pushMainThinkingDelta
} from './mainDeltaCoalescer'
import { ArtifactStore } from '../../runtime/artifacts/ArtifactStore'
import type { ContentBlock } from '../../runtime/model/types'
import { extractTextFromContent } from '../../runtime/model/types'
import { runVerification } from '../../runtime/verification/service'
import { formatVerificationSummary } from '../../runtime/verification/format'
import { loadNovaSettings } from '../../runtime/settings/novaSettings'
import { syncTavilyApiKeyFromSettings } from '../../runtime/settings/syncTavilyApiKey'
import {
  computeWorkspaceHash,
  buildL1MemoryContext
} from '../../runtime/memory'
import { subscribeObservationCapture } from '../../runtime/memory/MemoryObservationBridge'
import { ensureObservationCaptureForSession } from '../services/MemoryConsolidationHost'
import { onUserTurnCompleteForExtract } from '../services/MemoryExtractHost'
import {
  getMemoryService
} from '../services/MemoryServiceHost'
import {
  getRunCoordinator,
  getRunExecutionRegistry,
  getActiveRunId,
  setActiveRunId
} from '../services/RunCoordinatorHost'

/**
 * 供 WorkspaceService 分叉 IPC 守卫：生成中禁止改 currentLeafId。
 * 权威来源：RunCoordinator 非终态 run，或仍有未 settled 的执行句柄（含 interrupted 后 lingering）。
 */
export function isAgentTurnInProgress(): boolean {
  try {
    if (getRunExecutionRegistry().hasUnsettledHandle('agent')) return true
    return getRunCoordinator().listActiveRuns().length > 0
  } catch {
    return getActiveRunId() !== null
  }
}

/** 供跨会话守卫：当前活跃轮次所属会话 id（无进行中轮次时为 null） */
export function getActiveTurnSessionId(): string | null {
  try {
    const active = getRunCoordinator().listActiveRuns()
    if (active.length === 0) return null
    // 优先当前 SEND_MESSAGE 绑定的 run
    const bound = getActiveRunId()
    if (bound) {
      const snap = active.find(s => s.runId === bound)
      if (snap) return snap.sessionId
    }
    return active[0]?.sessionId ?? null
  } catch {
    return null
  }
}

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

interface PendingAskQuestionEntry {
  resolve: (answers: AskQuestionAnswer[]) => void
  eventBus: EventBus
}

/** 等待用户回复的 askQuestion 请求（requestId → 挂起状态）。与 verification permission 不同，无超时 */
export const pendingAskQuestions = new Map<string, PendingAskQuestionEntry>()

/**
 * 当前 AgentLoop 引用：供 RunCoordinator terminal hook 触发 onCancel（exactly-once）。
 * 每次 SEND_MESSAGE 更新；dispose 后置空。
 */
let currentAgentLoopForHooks: AgentLoop | null = null
let terminalHooksRegistered = false

function ensureTerminalHooksRegistered(): void {
  if (terminalHooksRegistered) return
  terminalHooksRegistered = true
  try {
    const coord = getRunCoordinator()
    coord.onTerminalHook('onCancel', async (ctx) => {
      const loop = currentAgentLoopForHooks
      const messageId = ctx.snapshot.messageId
      if (!loop || !messageId) return
      await loop.getHookManager().trigger({
        event: 'onCancel',
        messageId,
        interrupted: true
      })
    })
  } catch {
    // RunCoordinator 尚未初始化时跳过；registerHandlers 会先 init
  }
}

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
 * 在 message_start 到 message_end 之间以有序 blocks 为唯一事实源累积 assistant 消息。
 * content / toolCalls 仅在落盘时由 blocks 投影，不在内存双向可写。
 */
interface StreamAccumulator {
  /** 有序块：thinking / text / tool —— 唯一事实源 */
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
 * 把 nova-image:// URL 临时读回 base64 data URL，仅供发给模型 API（模型不认识自定义协议）。
 * 不持久化——持久化始终只存 nova-image:// URL。
 *
 * 读盘失败时回退为最小占位 data URL（1x1 png），避免整条消息因单张图读盘失败而中断；
 * 落盘失败属异常路径，会记 error 日志便于排查。
 *
 * 同步读盘：图片通常 <5MB，读盘 <10ms，远小于一次模型 API 调用（数秒），不是性能瓶颈。
 * 若未来支持超大图片，可在此处改异步（但会向上传导到 contextBuilder 整条链路）。
 */
function resolveToDataUrl(imageStore: ImageStore, url: string, fallbackMime?: string): string {
  const resolved = imageStore.resolveUrl(url)
  if (!resolved) {
    console.error(`[agentHandler] 图片 URL 解析失败，回退占位: ${url}`)
    return PLACEHOLDER_PNG_DATA_URL
  }
  try {
    const buffer = fs.readFileSync(resolved.filePath)
    // octet-stream 表示扩展名未能推导 MIME，用渲染层传入的 mimeType 兜底
    const mime = resolved.mimeType === 'application/octet-stream' && fallbackMime
      ? fallbackMime
      : resolved.mimeType
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch (err) {
    console.error(`[agentHandler] 图片读盘失败，回退占位: ${resolved.filePath}`, err)
    return PLACEHOLDER_PNG_DATA_URL
  }
}

/** 1x1 透明 PNG，作为图片读盘异常时的占位兜底 */
const PLACEHOLDER_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

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

  // 发送消息命令
  handle(SEND_MESSAGE, async (_event, params: {
    sessionId: string
    content: string
    userMessageId?: string
    images?: Array<{ fileName: string; data: string; mimeType: string }>
    regenerate?: boolean
  }): Promise<void> => {
    // 守卫改读 RunCoordinator：有非终态 run 则拒发（UI 侧靠 run:snapshot 同步）
    if (isAgentTurnInProgress()) {
      const whereSession = getActiveTurnSessionId()
      const where = whereSession && whereSession !== params.sessionId
        ? '（在另一个会话中）'
        : ''
      throw new Error(`Agent 正在运行${where}，请先点击停止按钮结束当前任务后再发送`)
    }

    // guardFollowup：用户在提问面板打开时发送新消息 → 自动 dismiss 所有挂起的 askQuestion 请求，
    // 避免旧工具死等。空 answers → formatAnswers 输出 "User dismissed the question."。
    if (pendingAskQuestions.size > 0) {
      for (const [requestId, entry] of pendingAskQuestions) {
        pendingAskQuestions.delete(requestId)
        entry.resolve([])
        entry.eventBus.emit({ type: 'ask_question_resolved', requestId })
      }
    }

    const modelClient = getModelClient()
    if (!modelClient) {
      throw new Error('模型未配置，请先在侧边栏底部设置中配置并连接模型。')
    }

    const sessionStore = getSessionStore()
    const session = sessionStore.load(params.sessionId)
    if (!session) {
      throw new Error(`会话 ${params.sessionId} 不存在`)
    }

    // Preflight：不得在这些可预见的输入错误前创建 run。
    if (params.regenerate === true) {
      const activePath = getSessionActiveMessages(session)
      const leafUser = activePath[activePath.length - 1]
      if (!leafUser || leafUser.role !== 'user') {
        throw new Error('重新生成失败：当前激活叶子不是用户消息')
      }
      if (params.images && params.images.length > 0) {
        throw new Error('重新生成暂不支持含图片的消息')
      }
    }

    const projectPath = session.workspaceRoot
    const sessionsDir = sessionStore.getSessionsDir()
    const novaSettings = loadNovaSettings()

    // 在闭包中捕获本次调用的全部上下文，后续所有操作只读这些值
    const capturedSessionId = params.sessionId
    const capturedMode = session.mode
    const capturedPermissionPolicy = novaSettings.permissionPolicy
    const capturedWorkspaceRoot = projectPath
    const capturedSessionsDir = sessionsDir
    const artifactStore = new ArtifactStore(sessionsDir)

    // 读取持久化配置以获取模型上下文窗口上限，用于动态压缩阈值
    const persistedConfig = loadModelConfig(app.getPath('userData'))
    const contextWindow = persistedConfig?.contextWindow ?? inferContextWindow(persistedConfig?.modelId ?? '')
    const supportsVision = resolveSupportsVision(
      persistedConfig?.modelId ?? '',
      persistedConfig?.supportsVision
    )
    if (params.images && params.images.length > 0 && !supportsVision) {
      throw new Error(
        '当前模型不支持图片输入。请切换到支持视觉的模型后再发送图片，或仅发送文字。'
      )
    }
    syncTavilyApiKeyFromSettings()

    const skillService = getSkillService()
    if (skillService.getWorkspaceRoot() !== projectPath) {
      skillService.load(projectPath)
    }
    const skillRegistry = skillService.getRegistry()

    const projectRules = discoverProjectRules(projectPath)?.text ?? ''
    /** 行为契约层：模板化 base rules，与模式指令（挂 user 尾部）分离以保缓存前缀稳定 */
    const baseRules = renderBaseRules()
    const skillContext = buildSkillContextForMode(
      session.mode,
      (profile, opts) => skillRegistry.listForContext(profile, opts),
      () => skillRegistry.listHidden()
    )
    /** 技能正文独立 token 估算(传入 AgentLoop,作为"技能"分项桶) */
    const skillsTokenEstimate = estimateTokens(skillContext)

    // L1 项目记忆：直读 MEMORY.md 注入 system prompt（不进 context hook / 不写 SessionStore）
    const scopeId = computeWorkspaceHash(projectPath)
    let memoryContext: string | null = null
    if (novaSettings.memoryEnabled) {
      try {
        const memoryService = getMemoryService()
        const essence = memoryService.getProjectEssence(scopeId)
        memoryContext = buildL1MemoryContext(essence)
      } catch (err) {
        console.warn('[agentHandler] L1 记忆注入失败，本轮降级跳过:', err)
        memoryContext = null
      }
    }

    const eventBus = new EventBus()
    const permissionManager = new PermissionManager()
    // 注入持久化权限规则 + 当前项目路径，用于匹配 allow/deny/ask
    permissionManager.setRules(listPermissionRules(projectPath))
    permissionManager.setCurrentProjectPath(projectPath)
    permissionManager.setSessionId(params.sessionId)
    // 工具批准策略（仅约束 default；compose 固定 auto 语义）
    permissionManager.setPermissionPolicy(novaSettings.permissionPolicy)

    const toolRegistry = new ToolRegistry()
    // ⚠️ 新增工具时除了在此 register，还必须：(1) 在 shared/session/toolVisibility.getToolCapability
    // 登记能力分类（否则落 unknown→被权限层当 bash 误弹确认）；(2) 在 renderer toolDisplay 补显示名。
    // 回归守卫见 tests/unit/runtime/tools/toolCapabilityCoverage.test.ts（漏登记会直接变红）。
    toolRegistry.register(lsTool)
    toolRegistry.register(readTool)
    toolRegistry.register(createGrepTool({ maxResultSizeChars: 100_000 }))
    toolRegistry.register(findTool)
    toolRegistry.register(webSearchTool)
    toolRegistry.register(createMemorySearchTool({
      getMemoryService,
      loadSettings: loadNovaSettings
    }))
    toolRegistry.register(editTool)
    toolRegistry.register(writeTool)
    toolRegistry.register(bashTool)
    toolRegistry.register(todoWriteTool)
    toolRegistry.register(askQuestionTool)
    toolRegistry.register(createInvokeSkillTool({
      modelClient,
      skillRegistry,
      useUnifiedSkillDispatch: USE_UNIFIED_SKILL_DISPATCH,
      parentEventBus: eventBus,
      resolveTool: (name) => toolRegistry.getTool(name),
      contextWindow,
      supportsVision,
      // 工具创建早于 AgentLoop；执行时 agentLoop 已赋值，闭包惰性读取模块级变量
      onSkillInvoked: (skill) => {
        agentLoop?.addSkillRoot(skill.directory)
      }
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
        memoryContext,
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
    currentAgentLoopForHooks = agentLoop

    // 仅提前取得协调器；所有会抛错的装配和输入准备完成后才创建 run。
    const runCoordinator = getRunCoordinator()
    let capturedRunId = ''
    let executionGeneration = 0
    let resolveExecutionSettled!: () => void
    const executionRegistry = getRunExecutionRegistry()

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
    // 统一 slash 调度：skill 注册表 + fork 依赖
    agentLoop.setSkillRegistry(skillRegistry)
    // 跨轮恢复：上次 send-message 已 dispose 旧 loop，从会话元数据灌回 skill 可读根
    agentLoop.restoreSkillRoots(session.grantedSkillRoots)
    agentLoop.setOnSkillRootAdded((dir) => {
      sessionStore.addGrantedSkillRoot(capturedSessionId, dir)
    })
    agentLoop.setSkillForkDeps({
      modelClient,
      parentEventBus: eventBus,
      resolveTool: (name) => toolRegistry.getTool(name),
      contextWindow,
      supportsVision
    })
    // 注入会话上下文：todo_write 工具通过它写会话元数据
    // 必须在 injectHistory 之前设置 sessionId，否则恢复历史后触发的
    // context_breakdown 事件会带上空 sessionId。
    agentLoop.setSessionContext(sessionStore, params.sessionId)
    agentLoop.setArtifactStore(artifactStore)
    // 注入主 readState：跨多次 SEND_MESSAGE 复用，使得同一会话连发消息时
    // 第二条消息能继续享受第一条消息的 read 状态（I1 实例化）
    agentLoop.setReadState(mainReadState)
    // 注入 askQuestion 阻塞回调：工具 execute() 通过它拿 Promise 并阻塞等待 renderer 回复。
    // 回调闭包捕获本次 eventBus，与 pendingVerificationPermissions 同隔离模式（每次 SEND_MESSAGE 都 new EventBus）。
    // 不设 timeout：用户必须显式回答 / dismiss / 新消息 / cancel 四条出口之一，不做自动兜底。
    // 同时写入 InteractionInbox（持久化归属），供 snapshot-first 恢复。
    agentLoop.setAskQuestionHandler((requestId, questions) => {
      return new Promise<AskQuestionAnswer[]>((resolve) => {
        pendingAskQuestions.set(requestId, { resolve, eventBus })
        const messageId =
          [...activeStreams.keys()].at(-1) ??
          runCoordinator.getSnapshot(capturedRunId)?.messageId ??
          ''
        const interaction = runCoordinator.inbox.enqueue({
          runId: capturedRunId,
          sessionId: capturedSessionId,
          messageId,
          type: 'askQuestion',
          interactionId: requestId,
          payload: { requestId, questions }
        })
        eventBus.emit({
          type: 'ask_question_request',
          requestId,
          questions,
          sessionId: capturedSessionId,
          messageId,
          runId: capturedRunId,
          interactionId: interaction.interactionId,
          version: interaction.version
        })
      })
    })

    // 从 session 历史恢复多轮对话上下文（快照优先 + 增量补齐，锚点失效则全量重建）。
    // 历史消息里的图片以 nova-image:// URL 持久化，模型不认识，恢复时需转回 base64。
    restoreOrInjectHistory(
      agentLoop,
      session,
      sessionStore.loadContextSnapshot(params.sessionId),
      (url) => resolveToDataUrl(getImageStore(), url)
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
      workspaceRoot: projectPath,
      getActivePathMessageIds: () => {
        const s = sessionStore.load(params.sessionId)
        if (!s) return undefined
        return new Set(getSessionActiveMessages(s).map(m => m.id))
      }
    })
    agentLoop.setCheckpointManager(checkpointManager)

    // 编排脚本 runner：/br-full-dev 等 workflow skill 入口
    agentLoop.setWorkflowRunner(async (scriptName, args, opts) => {
      if (session.mode !== 'compose') {
        getWorkspaceService().setMode({ mode: 'compose', sessionId: params.sessionId })
        agentLoop!.setMode('compose')
      }
      // compose run 内固定 auto 权限语义
      permissionManager.setPermissionPolicy('auto')

      const outcome = await runWorkflow({
        script: scriptName,
        args: { requirement: args, task: args },
        // 停止按钮 → AgentLoop.cancel() 的信号在此接入编排 run（否则 run 停不下来，
        // sendMessage 永挂起 → RunCoordinator 非终态占位 → 全局拒发消息）
        abortSignal: opts?.abortSignal,
        deps: {
          modelClient,
          parentEventBus: eventBus,
          resolveTool: (name) => toolRegistry.getTool(name),
          resolveSkill: (name) => skillRegistry.get(name),
          workspaceRoot: projectPath,
          permissionBridge: defaultSubAgentPermissionBridge,
          checkpointManager,
          contextWindow,
          supportsVision,
          mode: 'compose',
          sessionId: params.sessionId
        }
      })

      if (outcome.status === 'completed') {
        const summary =
          typeof outcome.result === 'string'
            ? outcome.result
            : `编排完成（runId=${outcome.runId}）\n${JSON.stringify(outcome.result, null, 2)}`
        return { summary }
      }
      if (outcome.status === 'cancelled') {
        return { summary: `编排已取消（runId=${outcome.runId}）` }
      }
      throw new Error(outcome.error || `编排失败（runId=${outcome.runId}）`)
    })

    const isRegenerate = params.regenerate === true

    // 追加前记录是否已有含文字的用户消息（用于首条文字消息自动生成标题）
    const hadTextUserMsg = session.messages.some(
      m => m.role === 'user' && extractTextFromSerializableContent(m.content).trim() !== ''
    )

    // 构建用户消息内容（含图片时为 ContentBlock[]，否则为 string）
    // modeInstruction 统一由 AgentLoop.sendMessage 追加，持久化中不包含
    let sendContent: string | ContentBlock[]
    if (isRegenerate) {
      const activePath = getSessionActiveMessages(session)
      const leafUser = activePath[activePath.length - 1]
      if (!leafUser || leafUser.role !== 'user') {
        throw new Error('重新生成失败：当前激活叶子不是用户消息')
      }
      if (params.images && params.images.length > 0) {
        throw new Error('重新生成暂不支持含图片的消息')
      }
      sendContent = extractTextFromSerializableContent(leafUser.content)
    } else {
      let persistContent: string | SerializableContentBlock[]
      const persistBlocks: import('../../shared/session/types').MessageBlock[] = []

      if (params.images && params.images.length > 0) {
        // 主进程双门闩：非视觉模型拒绝写入会话，避免 image_url 污染历史导致整段会话废掉。
        // 磁盘上已有的 nova-image 资产不在此删除；发 API 时由 visionProjection 按能力剥离。
        if (!supportsVision) {
          throw new Error(
            '当前模型不支持图片输入。请切换到支持视觉的模型后再发送图片，或仅发送文字。'
          )
        }
        // img.data 是 nova-image:// URL（渲染层上传时已落盘）。
        // 持久化只存 URL（几十字节）；发给模型时再把 URL 临时转回 base64 data URL。
        const imageReader = getImageStore()

        const imageContentBlocks: ContentBlock[] = [
          { type: 'text', text: params.content },
          ...params.images.map(img => ({
            type: 'image_url' as const,
            // 模型 API 仅认识 http(s) URL 或 data URL，nova-image:// 需转回 base64
            image_url: { url: resolveToDataUrl(imageReader, img.data, img.mimeType) }
          }))
        ]
        sendContent = imageContentBlocks

        // 持久化：content 与 blocks 都只存 nova-image:// URL，不再内联 base64
        persistContent = [
          { type: 'text', text: params.content },
          ...params.images.map(img => ({
            type: 'image_url' as const,
            image_url: { url: img.data }
          })) as SerializableContentBlock[]
        ]
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

      const userMessage: SessionMessageAppend = {
        // 与 renderer 乐观消息共用 id，避免分叉/编辑时「目标不在激活路径」
        id: params.userMessageId ?? `msg_${Date.now()}_user`,
        role: 'user',
        content: persistContent,
        blocks: persistBlocks.length > 0 ? persistBlocks : undefined,
        timestamp: Date.now()
      }
      sessionStore.appendMessageFast(params.sessionId, userMessage)

      // 首条含文字的用户消息后自动生成标题，并刷新侧边栏列表
      if (!hadTextUserMsg) {
        const newText = extractTextFromSerializableContent(persistContent).trim()
        if (newText !== '') {
          const title = generateSessionTitleFromText(newText)
          if (sessionStore.updateTitle(params.sessionId, title, 'generated')) {
            getWorkspaceService().refreshAvailableSessions()
          }
        }
      }
    }

    // 常驻黑匣子：stall 只认「RunCoordinator=running 且 heartbeat 超时」
    // 设 NOVA_STALL_DEBUG=0 可静默。详见 shared/diagnostics/stallDetector.ts
    const stallMark = createEventStallDetector({
      getRunLiveness: () => {
        try {
          return getRunCoordinator().getStallLiveness(capturedRunId)
        } catch {
          return null
        }
      }
    })

    eventBus.on((event: AgentEvent) => {
      // 投影关键事件到 RunCoordinator（工具对账 + message 绑定 + 权限 inbox）
      projectAgentEventToRun(capturedRunId, capturedSessionId, event)
      // 轻量刷新心跳（不落盘），stall 只认 running + heartbeat 超时
      try {
        getRunCoordinator().touchHeartbeat(capturedRunId)
      } catch { /* ignore */ }
      stallMark(event.type)
      forwardEventToRenderer(getMainWindow(), event)
      accumulateStreamEvent(capturedSessionId, event, {
        mode: capturedMode,
        permissionPolicy: capturedPermissionPolicy,
        workspaceRoot: capturedWorkspaceRoot,
        sessionsDir: capturedSessionsDir,
        eventBus,
        getMainWindow,
        runId: capturedRunId,
        executionGeneration
      })
    })

    // P2-2/3：工具轨迹采集（memoryEnabled 一键统控；巩固落盘由会话生命周期 / LLM 提炼触发）
    if (novaSettings.memoryEnabled && capturedWorkspaceRoot) {
      ensureObservationCaptureForSession(params.sessionId, capturedWorkspaceRoot)
      subscribeObservationCapture(eventBus, params.sessionId)
    }

    // Execution：此后立即进入 try/catch/finally，run 的每个出口都由同一处收敛。
    // 全局 AgentLoop：旧 handle 未 settled 时禁止开启新的共享 loop（含 interrupted lingering）
    if (executionRegistry.hasUnsettledHandle('agent')) {
      throw new Error('上一次 Agent 执行尚未完全退出，请稍候再发送（避免与旧 continuation 重叠）')
    }
    const runSnap = runCoordinator.startRun({
      kind: session.mode === 'compose' ? 'compose' : 'agent',
      workspaceId: projectPath,
      sessionId: params.sessionId
    })
    capturedRunId = runSnap.runId
    executionGeneration = Date.now()
    const executionSettled = new Promise<void>(resolve => {
      resolveExecutionSettled = resolve
    })
    executionRegistry.register({
      runId: capturedRunId,
      generation: executionGeneration,
      kind: session.mode === 'compose' ? 'compose' : 'agent',
      abort: () => agentLoop?.cancel(),
      settled: executionSettled
    })
    runCoordinator.bindExecutionGeneration(capturedRunId, executionGeneration)
    setActiveRunId(capturedRunId)
    runCoordinator.markRunning(capturedRunId)

    let turnFailed = false
    try {
      await agentLoop.sendMessage(sendContent)
      onUserTurnCompleteForExtract(
        params.sessionId,
        projectPath,
        sessionStore,
        modelPool
      )
    } catch (err) {
      turnFailed = true
      const reason = err instanceof Error ? err.message : String(err)
      try {
        getRunCoordinator().commitTerminal({
          runId: capturedRunId,
          status: 'failed',
          reason
        })
      } catch { /* ignore */ }
      throw err
    } finally {
      // 若尚未终态（正常完成或取消路径已 commit），补 completed
      const coord = getRunCoordinator()
      const snap = coord.getSnapshot(capturedRunId)
      if (snap && !['completed', 'failed', 'cancelled', 'interrupted'].includes(snap.status)) {
        if (!turnFailed) {
          const cancelled = snap.status === 'cancelling'
          coord.commitTerminal({
            runId: capturedRunId,
            status: cancelled ? 'cancelled' : 'completed'
          })
        }
      }
      resolveExecutionSettled()
      executionRegistry.unregister(capturedRunId, executionGeneration)
      setActiveRunId(null)
    }
  })

  handle(CANCEL_EXECUTION, async (): Promise<{ runId: string | null; status: string }> => {
    const runId = getActiveRunId()
    const coord = getRunCoordinator()
    if (runId) {
      coord.beginCancel(runId)
      coord.inbox.cancelAllForRun(runId)
      // abort 会等待执行收敛；终态仍由 SEND_MESSAGE 的 finally 统一提交。
      await getRunExecutionRegistry().abort(runId, 'cancel_execution')
    }

    // 先停父 agent，再联动停所有活跃子代理。
    // 顺序：父先 cancel 可避免父在子停止后又派新的工具调用；子 cancel 后父的
    // await subLoop.sendMessage(task) 才会在最近的 abort 检查点返回。
    agentLoop?.cancel()
    defaultSubAgentPermissionBridge.cancelAll()
    defaultSubAgentPermissionBridge.clear()
    markActiveStreamsCancelled()
    clearAllPendingVerificationPermissions()
    // 清理挂起的 askQuestion：空 answers 让工具走 dismissed 路径，UI 面板随之关闭
    for (const [requestId, entry] of pendingAskQuestions) {
      pendingAskQuestions.delete(requestId)
      entry.resolve([])
      entry.eventBus.emit({ type: 'ask_question_resolved', requestId })
    }

    // 终态由 sendMessage finally / commitTerminal 确认；此处只返回 cancelling
    const snap = runId ? coord.getSnapshot(runId) : null
    return { runId, status: snap?.status ?? 'idle' }
  })

  handle(RESPOND_PERMISSION, async (_event, params: {
    requestId: string
    decision: PermissionDecision
    commandId?: string
    expectedVersion?: number
    interactionId?: string
  }): Promise<void | import('../../runtime/run').InteractionAnswerResult> => {
    const granted = params.decision === 'allow'
    const interactionId = params.interactionId ?? params.requestId
    const coord = getRunCoordinator()
    const found = coord.findInteraction(interactionId)

    // InteractionInbox 幂等路径（有 commandId 时）
    if (params.commandId && found) {
      const result = coord.inbox.answer({
        interactionId,
        commandId: params.commandId,
        expectedVersion: params.expectedVersion ?? found.version,
        outcome: granted ? 'answered' : 'dismissed',
        payload: { decision: params.decision }
      })
      if (!result.ok) return result
    }

    // 子代理权限（sub: 前缀）路由到子 AgentLoop，其余走父循环
    if (defaultSubAgentPermissionBridge.resolve(params.requestId, granted)) return
    if (!agentLoop) return
    agentLoop.respondPermission(params.requestId, granted)
    if (params.commandId && found) {
      return {
        ok: true,
        interaction: coord.findInteraction(interactionId)!,
        snapshot: coord.getSnapshot(found.runId)!
      }
    }
  })

  handle(RESPOND_VERIFICATION_PERMISSION, async (_event, params: { requestId: string; granted: boolean }): Promise<void> => {
    clearVerificationPermissionRequest(params.requestId, params.granted)
  })

  handle(RESPOND_ASK_QUESTION, async (_event, params: {
    requestId: string
    answers: AskQuestionAnswer[]
    commandId?: string
    expectedVersion?: number
    interactionId?: string
  }): Promise<void | import('../../runtime/run').InteractionAnswerResult> => {
    const interactionId = params.interactionId ?? params.requestId
    const coord = getRunCoordinator()
    const found = coord.findInteraction(interactionId)
    const dismissed = !params.answers || params.answers.length === 0

    if (params.commandId && found) {
      const result = coord.inbox.answer({
        interactionId,
        commandId: params.commandId,
        expectedVersion: params.expectedVersion ?? found.version,
        outcome: dismissed ? 'dismissed' : 'answered',
        payload: { answers: params.answers }
      })
      if (!result.ok) return result
    }

    const entry = pendingAskQuestions.get(params.requestId)
    if (!entry) {
      if (params.commandId) {
        return {
          ok: false,
          code: 'not_found',
          message: `askQuestion ${params.requestId} 不存在`
        }
      }
      return
    }
    pendingAskQuestions.delete(params.requestId)
    // resolve 工具的 Promise，让 execute 继续往下走
    entry.resolve(params.answers)
    // 通知 renderer 清除 pending 状态
    entry.eventBus.emit({ type: 'ask_question_resolved', requestId: params.requestId })

    if (params.commandId && found) {
      return {
        ok: true,
        interaction: coord.findInteraction(interactionId) ?? found,
        snapshot: coord.getSnapshot(found.runId)!
      }
    }
  })
}

/**
 * 将 AgentEvent 投影到 RunCoordinator（工具对账 / 权限 inbox / message 绑定）。
 * 旧 EventBus → IPC 路径保持不变，本函数只做旁路持久化。
 */
function projectAgentEventToRun(
  runId: string,
  sessionId: string,
  event: AgentEvent
): void {
  let coord: ReturnType<typeof getRunCoordinator>
  try {
    coord = getRunCoordinator()
  } catch {
    return
  }

  switch (event.type) {
    case 'message_start':
      coord.setMessageId(runId, event.messageId)
      if (!coord.getSnapshot(runId)?.turnStartedAt) {
        coord.markRunning(runId, event.messageId)
      }
      break
    case 'tool_call': {
      // prepared → executing：工具参数已就绪，即将执行
      const idempotent = isIdempotentToolName(event.toolName)
      coord.recordToolPhase(runId, event.toolCallId, event.toolName, 'prepared', { idempotent })
      coord.recordToolPhase(runId, event.toolCallId, event.toolName, 'executing', { idempotent })
      break
    }
    case 'tool_result': {
      const isError =
        event.result.startsWith('工具执行失败') || event.result.startsWith('权限拒绝:')
      coord.recordToolPhase(
        runId,
        event.toolCallId,
        event.toolName,
        isError ? 'failed' : 'committed',
        { idempotent: isIdempotentToolName(event.toolName) }
      )
      break
    }
    case 'permission_request': {
      coord.inbox.enqueue({
        runId,
        sessionId,
        messageId: event.messageId,
        type: 'permission',
        interactionId: event.requestId,
        payload: {
          requestId: event.requestId,
          toolName: event.toolName,
          args: event.args,
          riskLevel: event.riskLevel,
          reason: event.reason,
          commands: event.commands,
          toolCallIds: event.toolCallIds
        }
      })
      break
    }
    case 'verification_permission_request': {
      coord.inbox.enqueue({
        runId,
        sessionId,
        messageId: event.messageId,
        type: 'verification',
        interactionId: event.requestId,
        payload: {
          requestId: event.requestId,
          command: event.command
        }
      })
      break
    }
    case 'message_end': {
      // 终态由 SEND_MESSAGE finally 统一 commit；此处只心跳
      coord.heartbeat(runId, { label: event.interrupted ? 'interrupted' : 'message_end' })
      break
    }
    default:
      break
  }
}

/** 只读类工具可视为幂等；写入类默认非幂等，中断后不自动重放 */
function isIdempotentToolName(toolName: string): boolean {
  const readOnly = new Set([
    'read',
    'ls',
    'grep',
    'find',
    'webSearch',
    'memorySearch',
    'askQuestion'
  ])
  return readOnly.has(toolName)
}

/** 每次消息处理需要的上下文快照，避免读全局变量 */
export interface MessageContext {
  mode: Mode
  /** 工具批准策略（验证弹窗：default+ask 才确认） */
  permissionPolicy: import('../../shared/session/types').PermissionPolicy
  workspaceRoot: string
  sessionsDir: string
  eventBus: EventBus
  getMainWindow: () => BrowserWindow | null
  /** 当前权威 runId；用于工具边界写入 turnDraft */
  runId?: string
  /** 当前执行 generation；副作用前后 fencing */
  executionGeneration?: number
}

/**
 * 累积流式事件内容
 */
export function accumulateStreamEvent(sessionId: string, event: AgentEvent, ctx: MessageContext): void {
  // 注意：tool_call_start / tool_call_delta 是流式增量事件，不写 stream 累积器。
  // 持久化只关心最终完整 tool_call（由 tool_call 事件写入），增量不落盘。
  // 累积器以有序 blocks 为唯一事实源；content/toolCalls 仅在 message_end 投影。
  switch (event.type) {
    case 'message_start': {
      activeStreams.set(event.messageId, { blocks: [], cancelled: false })
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
        stream.blocks.push({
          type: 'tool',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.args,
          status: 'running'
        })
        // 工具参数就绪即落盘草稿，崩溃后可恢复「已准备未执行」边界
        persistTurnDraft(ctx.runId, event.messageId, stream.blocks, false, ctx.executionGeneration)
      }
      break
    }
    case 'tool_result': {
      const stream = activeStreams.get(event.messageId)
      if (stream) {
        const isError = event.result.startsWith('工具执行失败') || event.result.startsWith('权限拒绝:')
        const blockIdx = stream.blocks.findIndex(b => b.type === 'tool' && b.toolCallId === event.toolCallId)
        if (blockIdx !== -1 && stream.blocks[blockIdx].type === 'tool') {
          const block = stream.blocks[blockIdx]
          stream.blocks[blockIdx] = {
            ...block,
            status: isError ? 'error' : 'success',
            result: event.result
          } as typeof block
        }
        // 工具结果边界：turnDraft 是执行中唯一事实源（fsync via RunStore）
        persistTurnDraft(ctx.runId, event.messageId, stream.blocks, false, ctx.executionGeneration)
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

        // cancel 期间残留的"权限拒绝"工具块不应进入持久化历史
        const blocks = stream.cancelled
          ? dropPermissionDeniedResidualBlocks(stream.blocks)
          : stream.blocks

        // 所有权转移：先标记草稿 finalized，再写入 SessionStore，最后清除草稿
        persistTurnDraft(ctx.runId, event.messageId, blocks, true, ctx.executionGeneration)
        saveAssistantMessage(sessionId, event.messageId, blocks, event.interrupted)
        clearTurnDraftAfterFinalize(ctx.runId)
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
    case 'attempt_failed': {
      // 失败 attempt：清空累积器中的临时块，保留条目供下一次 attempt 继续写
      const stream = activeStreams.get(event.messageId)
      if (stream) {
        stream.blocks = []
      }
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
        permissionPolicy: ctx.permissionPolicy,
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

/** 将验证摘要追加到已保存的 assistant 消息（append-only patch，不重写全历史） */
function appendVerificationSummary(sessionId: string, messageId: string, summary: string): void {
  const sessionStore = getSessionStore()
  sessionStore.appendMessagePatch(sessionId, messageId, { verificationSummary: summary })
}

/** 保存完整的 assistant 消息到会话存储（blocks 为事实源，content/toolCalls 为投影） */
function saveAssistantMessage(
  sessionId: string,
  messageId: string,
  blocks: MessageBlock[],
  interrupted?: boolean
): void {
  const sessionStore = getSessionStore()
  const projected = projectAssistantFieldsFromBlocks(blocks)
  const assistantMessage: SessionMessageAppend = {
    id: messageId,
    role: 'assistant',
    content: projected.content,
    toolCalls: projected.toolCalls,
    blocks: projected.blocks.length > 0 ? projected.blocks : undefined,
    messageSchemaVersion: MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE,
    timestamp: Date.now(),
    // 取消中断的消息也持久化 interrupted 标记，下次加载时 UI 仍能区分
    ...(interrupted ? { interrupted: true } : {})
  }
  sessionStore.appendMessageFast(sessionId, assistantMessage)
}

/**
 * 工具边界：把当前 blocks 写入 RunSnapshot.turnDraft（fsync）。
 * 执行中唯一事实源；SessionStore 仅在 finalize 后接手。
 * generation 失效后拒绝写入，防止 lingering continuation 覆盖。
 */
function persistTurnDraft(
  runId: string | undefined,
  messageId: string,
  blocks: MessageBlock[],
  finalized = false,
  executionGeneration?: number
): void {
  if (!runId) return
  const coord = getRunCoordinator()
  if (
    executionGeneration != null &&
    !coord.isExecutionCurrent(runId, executionGeneration)
  ) {
    console.warn(
      `[persistTurnDraft] generation 已失效，拒绝写入 runId=${runId} gen=${executionGeneration}`
    )
    return
  }
  // 落盘失败必须抛出，不得吞掉后继续宣称可恢复
  coord.upsertTurnDraft(runId, {
    messageId,
    blocks: blocks as unknown as Array<Record<string, unknown>>,
    finalized
  })
}

/** SessionStore 写入成功后清除草稿，完成所有权转移 */
function clearTurnDraftAfterFinalize(runId: string | undefined): void {
  if (!runId) return
  try {
    getRunCoordinator().clearTurnDraft(runId)
  } catch {
    /* ignore */
  }
}

/**
 * 兜底过滤：剔除"权限拒绝: 用户拒绝"残留 tool 块。
 * 只剔除用户拒绝产生的条目，保留模式策略引发的拒绝。
 */
function dropPermissionDeniedResidualBlocks(blocks: MessageBlock[]): MessageBlock[] {
  return blocks.filter(b => {
    if (b.type !== 'tool') return true
    const result = b.result ?? ''
    return !(result.startsWith('权限拒绝:') && result.includes('用户拒绝'))
  })
}

/** 保存错误消息到会话存储 */
function saveErrorMessage(sessionId: string, messageId: string, error: string): void {
  const sessionStore = getSessionStore()
  const errorMessage: SessionMessageAppend = {
    id: messageId,
    role: 'assistant',
    content: error,
    timestamp: Date.now()
  }
  sessionStore.appendMessageFast(sessionId, errorMessage)
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

  // 轮次边界：先 flush 合帧缓冲，避免 delta 与终态事件错位
  const flushBeforeSend =
    event.type === 'message_start' ||
    event.type === 'tool_call_start' ||
    event.type === 'tool_call' ||
    event.type === 'message_end' ||
    event.type === 'error' ||
    event.type === 'attempt_failed'

  if (flushBeforeSend) {
    flushMainDeltaCoalescer(mainWindow)
  }

  switch (event.type) {
    case 'message_start':
      webContents.send('agent:message-start', { messageId: event.messageId })
      break
    case 'thinking_delta':
      pushMainThinkingDelta(mainWindow, event.messageId, event.delta)
      break
    case 'text_delta':
      pushMainTextDelta(mainWindow, event.messageId, event.delta)
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
    case 'ask_question_request':
      webContents.send('agent:ask-question-request', {
        requestId: event.requestId,
        questions: event.questions,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.messageId ? { messageId: event.messageId } : {}),
        ...(event.runId ? { runId: event.runId } : {}),
        ...(event.interactionId ? { interactionId: event.interactionId } : {}),
        ...(event.version !== undefined ? { version: event.version } : {})
      })
      break
    case 'ask_question_resolved':
      webContents.send('agent:ask-question-resolved', {
        requestId: event.requestId
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
    case 'attempt_failed':
      webContents.send('agent:attempt-failed', {
        messageId: event.messageId,
        attemptId: event.attemptId,
        error: event.error
      })
      break
    case 'message_end':
      webContents.send('agent:message-end', {
        messageId: event.messageId,
        ...(event.interrupted ? { interrupted: true } : {})
      })
      break
    case 'workflow_phase':
      webContents.send('compose:phase-change', {
        runId: event.runId,
        sessionId: event.sessionId,
        phase: event.phase
      })
      break
    case 'workflow_log':
      webContents.send('compose:log', {
        runId: event.runId,
        sessionId: event.sessionId,
        message: event.message
      })
      break
    case 'workflow_agent_failed':
      // 可观测事件，阶段 E UI 可订阅；当前仅转发为 log
      webContents.send('compose:log', {
        runId: event.runId,
        sessionId: event.sessionId,
        message: `[agent-failed] ${event.reason}`
      })
      break
    case 'workflow_ask_user':
      webContents.send('compose:ask-user', {
        runId: event.runId,
        sessionId: event.sessionId,
        requestId: event.requestId,
        question: event.question,
        options: event.options
      })
      break
    case 'workflow_task_update':
      webContents.send('compose:task-update', {
        runId: event.runId,
        sessionId: event.sessionId,
        tasks: event.tasks
      })
      break
    case 'workflow_state':
      webContents.send('compose:state', {
        runId: event.runId,
        sessionId: event.sessionId,
        state: event.state
      })
      break
  }
}
