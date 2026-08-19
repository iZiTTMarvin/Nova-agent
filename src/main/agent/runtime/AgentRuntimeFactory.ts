/**
 * AgentRuntimeFactory — 装配单轮执行所需的模型、工具、权限、prompt、cache、memory、skill 与 AgentLoop。
 * 不创建 run、不写用户消息、不发 terminal。
 */
import { app } from 'electron'
import { join } from 'path'
import {
  AgentLoop,
  EventBus,
  renderModeToolInventory,
  buildStableSystemPrompt,
  buildSkillContextForMode,
  estimateTokens,
  discoverProjectRules,
  renderBaseRules
} from '../../../runtime/agent'
import { projectEffectiveToolDefinitions } from '../../../runtime/agent/core/AgentContext'
import { TurnDispatcher } from '../../../runtime/agent/turn'
import { runSkillFork } from '../../../runtime/skills/runSkillFork'
import { loadModelConfig } from '../../../runtime/model/config'
import { resolveContextWindow, resolveSupportsVision } from '../../../shared/config/types'
import { preferredToolDialect } from '../../../runtime/model/dialect'
import { resolveCacheProfile } from '../../../runtime/model/cacheProfile'
import { OpenAICompatibleModelClient } from '../../../runtime/model/OpenAICompatibleModelClient'
import { ModelClientPool } from '../../../runtime/model/ModelClientPool'
import { ToolRegistry } from '../../../runtime/tools/ToolRegistry'
import { ToolAvailability, resolveToolEconomyMode } from '../../../runtime/tools/availability'
import {
  getProcessToolPresentationMode,
  renderCodeModeSdkSection,
  resolveCodeModeToolBindings
} from '../../../runtime/code-mode'
import type { ReadState } from '../../../runtime/tools/editTool'
import { PermissionManager } from '../../../runtime/permissions/PermissionManager'
import { listPermissionRules } from '../../../runtime/permissions/PermissionService'
import { CheckpointManager } from '../../../runtime/checkpoints/CheckpointManager'
import type { ModelClient } from '../../../runtime/model/ModelClient'
import type { AskQuestionItem, AskQuestionAnswer } from '../../../shared/askQuestion/types'
import type { SessionData } from '../../../runtime/sessions/types'
import type { SessionStore } from '../../../runtime/sessions/SessionStore'
import { getSessionActiveMessages } from '../../../runtime/sessions/tree'
import {
  persistCompactionSnapshot,
  restoreOrInjectHistory
} from '../../../runtime/sessions/contextSnapshot'
import type { ImageStore } from '../../../runtime/storage/ImageStore'
import { ArtifactStore } from '../../../runtime/artifacts/ArtifactStore'
import type { NovaSettings } from '../../../runtime/settings/novaSettings'
import { loadNovaSettings } from '../../../runtime/settings/novaSettings'
import {
  computeWorkspaceHash,
  createMemoryPrefetchWiring,
  MEMORY_POLICY_PROMPT
} from '../../../runtime/memory'
import type { SkillRegistry } from '../../../runtime/skills/SkillRegistry'
import type { RunCoordinator } from '../../../runtime/run/RunCoordinator'
import { getSkillService } from '../../services/SkillServiceHost'
import { getMemoryPrefetchService, getMemoryRetrievalService } from '../../services/MemoryServiceHost'
import { getWorkspaceService } from '../../services/WorkspaceService'
import { activeStreams } from '../events'
import { resolveToDataUrl } from './imageResolve'
import { registerBuiltinTools } from './registerBuiltinTools'
import {
  createComposeModeInstructionProvider,
  createComposeStageToolPolicy
} from './composeStageWiring'
import { loadDiagnosticState, saveDiagnosticState } from './diagnosticPersistence'
import { isReadablePlanInWorkspace } from '../../../runtime/plans'
import type { SpawnSubagentPort } from '../../../runtime/subagents'

export interface AgentRuntimeRunRefs {
  runId: string
  resourceOwnerRunId: string
  executionGeneration: number
}

export interface PendingAskQuestionEntry {
  /** 归属会话：并发下 dismiss 必须按会话过滤，避免误杀其它会话的提问 */
  sessionId: string
  runId: string
  resolve: (answers: AskQuestionAnswer[]) => void
  eventBus: EventBus
}

export interface PreparedAgentRuntime {
  eventBus: EventBus
  permissionManager: PermissionManager
  toolRegistry: ToolRegistry
  agentLoop: AgentLoop
  modelPool: ModelClient | ModelClientPool
  checkpointManager: CheckpointManager
  skillRegistry: SkillRegistry
  artifactStore: ArtifactStore
  contextWindow: number
  supportsVision: boolean
  /** 稳定 system prompt；由 TurnService 决定是否写回 session */
  frozenPrompt: string
  /** 由 TurnService / agentHandler 在 startRun 后填入；runners / askQuestion 读取 */
  runRefs: AgentRuntimeRunRefs
  setAskQuestionHandler: AgentLoop['setAskQuestionHandler']
}

/**
 * 为主 modelClient 构建 ModelClientPool。
 * - 读取磁盘 ModelConfig，若有 fallbacks 则为每个 fallback 创建 client 并组装 pool。
 * - 无 fallbacks 时返回单个 client（AgentLoop 构造函数会自动包装成无 fallback 的 pool）。
 * - fallback client 创建失败（配置非法）时跳过该条，不阻塞主流程。
 */
export function buildModelPoolWithFallbacks(primary: ModelClient): ModelClient | ModelClientPool {
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
        // 按 fallback 自身 baseUrl/modelId 解析 profile，禁止沿用主模型
        const fbProfile = resolveCacheProfile(fb.baseUrl, fb.modelId, {
          cacheProfile: fb.cacheProfile,
          cacheStrategy: fb.cacheStrategy
        })
        fbClient.setCacheStrategy(fbProfile.marker === 'cache_control' ? 'anthropic' : 'auto')
        fallbackSlots.push({ config: fb, client: fbClient })
      } catch (err) {
        console.error('[AgentRuntimeFactory] 创建 fallback client 失败，已跳过:', err)
      }
    }

    if (fallbackSlots.length === 0) return primary

    return new ModelClientPool({
      primary,
      primaryConfig: cfg,
      fallbacks: fallbackSlots.map((s) => ({ config: s.config, client: s.client }))
    })
  } catch (err) {
    console.error('[AgentRuntimeFactory] 构建 fallback pool 失败，回退单 client:', err)
    return primary
  }
}

export interface PrepareAgentRuntimeInput {
  session: SessionData
  sessionStore: SessionStore
  sessionId: string
  projectPath: string
  sessionsDir: string
  novaSettings: NovaSettings
  modelClient: ModelClient
  getImageStore: () => ImageStore
  readState: ReadState
  pendingAskQuestions: Map<string, PendingAskQuestionEntry>
  runCoordinator: RunCoordinator
  autoMode?: boolean
  /** 由 TurnService 预先 ensure 的 cache routing key；factory 不写 session */
  promptCacheKey?: string
  /** task 工具执行时读取；装配完成后由 TurnService 绑定本 turn 的执行服务。 */
  getSpawnSubagentPort?: () => SpawnSubagentPort | undefined
}

export function prepareAgentRuntime(input: PrepareAgentRuntimeInput): PreparedAgentRuntime {
  const {
    session,
    sessionStore,
    sessionId,
    projectPath,
    sessionsDir,
    novaSettings,
    modelClient,
    getImageStore,
    readState,
    pendingAskQuestions,
    runCoordinator,
    autoMode = false,
    promptCacheKey,
    getSpawnSubagentPort
  } = input

  const runRefs: AgentRuntimeRunRefs = {
    runId: '',
    resourceOwnerRunId: '',
    executionGeneration: 0
  }

  const artifactStore = new ArtifactStore(sessionsDir)

  const persistedConfig = loadModelConfig(app.getPath('userData'))
  const contextWindow = resolveContextWindow(
    persistedConfig?.modelId ?? '',
    persistedConfig?.contextWindow
  )
  const supportsVision = resolveSupportsVision(
    persistedConfig?.modelId ?? '',
    persistedConfig?.supportsVision
  )

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
    (profile) => skillRegistry.listForContext(profile)
  )
  /** 技能正文独立 token 估算(传入 AgentLoop,作为"技能"分项桶) */
  const skillsTokenEstimate = estimateTokens(skillContext)

  // 记忆层为固定 policy 文本：记忆数据变化不改变稳定 system prefix（缓存前缀契约）；
  // 动态记忆由下方 prefetch 接线以 ephemeral 消息进入当次请求。
  const memoryContext = novaSettings.memoryEnabled ? MEMORY_POLICY_PROMPT : null

  const eventBus = new EventBus()
  const permissionManager = new PermissionManager()
  permissionManager.setRules(listPermissionRules(projectPath))
  permissionManager.setCurrentProjectPath(projectPath)
  permissionManager.setSessionId(sessionId)
  permissionManager.setPermissionPolicy(novaSettings.permissionPolicy)

  const toolRegistry = new ToolRegistry()
  // Tool Economy 三态由内部策略决定（默认 off = 全量工具面，行为与历史一致）；
  // 激活态在注册完成后从会话持久化恢复，缺旧会话则回退消息 marker 回填。
  const toolAvailability = new ToolAvailability()
  toolAvailability.setEconomyMode(resolveToolEconomyMode())
  // 两阶段局部持有：invoke_skill 创建早于 AgentLoop，执行时惰性读取
  let loop: AgentLoop | null = null

  registerBuiltinTools(toolRegistry, {
    skillRegistry,
    getAgentLoop: () => loop,
    getMemoryRetrievalService,
    loadSettings: loadNovaSettings,
    getSpawnSubagentPort,
    getToolAvailability: () => toolAvailability,
    // 构建产物 out/main/codeModeWorker.js；缺失时 run_code 回退进程内沙箱
    codeModeWorkerPath: join(__dirname, 'codeModeWorker.js'),
    memoryEnabled: novaSettings.memoryEnabled
  })

  toolAvailability.bindRegisteredToolNames(
    toolRegistry.getToolDefinitions().map(def => def.name)
  )
  if (session.toolAvailability !== undefined) {
    const restored = toolAvailability.restoreFromSessionState(session.toolAvailability)
    if (restored.usable) {
      if (restored.restoredGroups.length > 0 && toolAvailability.getEconomyMode() !== 'off') {
        console.log(
          `[tool-economy] session-restore groups=${restored.restoredGroups.join(',')} mode=${toolAvailability.getEconomyMode()}`
        )
      }
    } else {
      // 字段损坏：视同缺失，回退消息回填并修复落盘
      const backfill = toolAvailability.backfillFromMessages(session.messages)
      sessionStore.updateToolAvailability(
        sessionId,
        backfill.restoredGroups.length > 0
          ? { version: 1, activatedGroups: [...backfill.restoredGroups] }
          : null
      )
    }
  } else {
    // 旧会话兼容：消息 marker 回填一次并落盘，此后不再依赖消息扫描
    const { restoredGroups } = toolAvailability.backfillFromMessages(session.messages)
    if (restoredGroups.length > 0) {
      sessionStore.updateToolAvailability(sessionId, {
        version: 1,
        activatedGroups: [...restoredGroups]
      })
    }
  }
  toolAvailability.setPersistCallback(state => {
    sessionStore.updateToolAvailability(sessionId, state)
  })

  const modelPool = buildModelPoolWithFallbacks(modelClient)
  const activeProvider =
    modelPool instanceof ModelClientPool
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
  // 呈现模式进程级一次解析（会话内稳定）：code-readonly 时只读探索工具改由 SDK 暴露
  const toolPresentation = getProcessToolPresentationMode()
  const effectiveToolDefinitions = projectEffectiveToolDefinitions(
    session.mode,
    toolRegistry.getToolDefinitions(),
    toolAvailability,
    toolPresentation
  )
  let toolSummary = renderModeToolInventory(session.mode, effectiveToolDefinitions, {
    dialect: toolDialect
  })
  if (toolPresentation === 'code-readonly') {
    const sandboxToolNames = new Set(resolveCodeModeToolBindings(session.mode, new Set(toolAvailability.getActiveToolNames())))
    const sandboxToolDefinitions = projectEffectiveToolDefinitions(
      session.mode,
      toolRegistry.getToolDefinitions(),
      toolAvailability
    ).filter(def => sandboxToolNames.has(def.name))
    toolSummary = `${toolSummary}\n\n${renderCodeModeSdkSection(sandboxToolDefinitions)}`
  }

  const frozenPrompt = buildStableSystemPrompt({
    workingDir: projectPath
  })

  const agentLoop = new AgentLoop(modelPool, eventBus, {
    systemPromptLayers: {
      agentRole: frozenPrompt,
      baseRules,
      projectRules,
      memoryContext,
      skillContext,
      toolSummary
    },
    skillsTokenEstimate,
    contextWindow,
    supportsVision,
    maxToolRounds: novaSettings.maxToolRounds,
    toolDialectOverride: persistedConfig?.toolDialect,
    promptCacheKey,
    reasoningEffort: session.reasoningEffortOverride,
    onCompaction: (compactedContext, meta) => {
      if (!persistCompactionSnapshot(sessionStore, sessionId, compactedContext, meta)) {
        console.error(`[onCompaction] 找不到会话 ${sessionId}，快照未写`)
      }
    }
  })
  loop = agentLoop

  agentLoop.setWorkingDir(projectPath)
  // 工作区根供写者租约按工作区分桶；runId 在 startRun 后由 AgentTurnService 注入
  agentLoop.setWorkspaceRoot(projectPath)
  agentLoop.setToolRegistry(toolRegistry)
  agentLoop.setToolAvailability(toolAvailability)
  agentLoop.setToolPresentation(toolPresentation)
  agentLoop.setBashEnvironment({
    binDirs: [join(projectPath, 'node_modules', '.bin')]
  })
  agentLoop.setPermissionManager(permissionManager)
  agentLoop.setMode(session.mode)
  agentLoop.setAutoMode(autoMode)
  // compose：模式指令与阶段指南挂 user 消息尾部（每轮实时读取阶段表），
  // 阶段工具门禁作为 overlay 在基础权限判定之前生效
  if (session.mode === 'compose') {
    agentLoop.setModeInstructionProvider(
      createComposeModeInstructionProvider(sessionStore, sessionId, autoMode)
    )
    agentLoop.setToolAuthorizationPolicy(createComposeStageToolPolicy(sessionStore, sessionId))
  }
  // 动态记忆 prefetch：turn 级 context hook，把检索块插入当次请求的用户消息之前。
  // 注入不触碰 system prompt / 持久化路径；服务不可用（如原生模块缺失）时整体跳过。
  if (novaSettings.memoryEnabled) {
    try {
      const wiring = createMemoryPrefetchWiring({
        prefetch: getMemoryPrefetchService(),
        projectScopeId: computeWorkspaceHash(projectPath),
        workspaceRoot: projectPath
      })
      const hooks = agentLoop.getHookManager()
      hooks.on('onMessageStart', wiring.onMessageStart)
      hooks.on('context', wiring.context)
    } catch (err) {
      console.warn('[AgentRuntimeFactory] 记忆 prefetch 接线失败，本轮跳过动态记忆:', err)
    }
  }
  agentLoop.restoreSkillRoots(session.grantedSkillRoots)
  agentLoop.setOnSkillRootAdded((dir) => {
    sessionStore.addGrantedSkillRoot(sessionId, dir)
  })
  agentLoop.setSessionContext(sessionStore, sessionId)
  agentLoop.setActivePlanPath(session.activePlan?.path)
  agentLoop.setSwitchModeHandler(async (targetMode, _reason) => {
    const currentSession = sessionStore.load(sessionId)
    if (!currentSession) {
      throw new Error('当前会话不存在')
    }
    if (currentSession.mode === 'compose') {
      throw new Error('compose 模式不能通过 switch_mode 切换')
    }
    if (currentSession.mode === 'plan' && targetMode === 'default') {
      const activePath = currentSession.activePlan?.path
      const hasReadableActivePlan = isReadablePlanInWorkspace(projectPath, activePath)
      if (!hasReadableActivePlan) {
        throw new Error('进入 default 前必须先用 save_plan 保存可读取的 active plan')
      }
    }
    if (currentSession.mode === targetMode) {
      return { previousMode: currentSession.mode, currentMode: targetMode }
    }

    const previousMode = currentSession.mode
    getWorkspaceService().setMode({ mode: targetMode, sessionId, source: 'agent' })
    agentLoop.setMode(targetMode)
    return { previousMode, currentMode: targetMode }
  })
  agentLoop.setArtifactStore(artifactStore)
  agentLoop.setReadState(readState)

  const askQuestionHandler = (
    requestId: string,
    questions: AskQuestionItem[]
  ): Promise<AskQuestionAnswer[]> => {
    return new Promise<AskQuestionAnswer[]>((resolve) => {
      pendingAskQuestions.set(requestId, {
        sessionId,
        runId: runRefs.runId,
        resolve,
        eventBus
      })
      const messageId =
        [...activeStreams.keys()].at(-1) ??
        runCoordinator.getSnapshot(runRefs.runId)?.messageId ??
        ''
      const interaction = runCoordinator.inbox.enqueue({
        runId: runRefs.runId,
        sessionId,
        messageId,
        type: 'askQuestion',
        interactionId: requestId,
        payload: { requestId, questions }
      })
      eventBus.emit({
        type: 'ask_question_request',
        requestId,
        questions,
        sessionId,
        messageId,
        runId: runRefs.runId,
        interactionId: interaction.interactionId,
        version: interaction.version
      })
    })
  }
  agentLoop.setAskQuestionHandler(askQuestionHandler)

  const providerForCache =
    modelPool instanceof ModelClientPool
      ? modelPool.getActiveProvider()
      : {
          baseUrl: persistedConfig?.baseUrl ?? '',
          modelId: persistedConfig?.modelId ?? '',
          cacheProfile: persistedConfig?.cacheProfile,
          cacheStrategy: persistedConfig?.cacheStrategy
        }
  const activeCacheProfile = resolveCacheProfile(
    providerForCache.baseUrl,
    providerForCache.modelId,
    {
      cacheProfile: providerForCache.cacheProfile,
      cacheStrategy: providerForCache.cacheStrategy
    }
  )
  restoreOrInjectHistory(agentLoop, session, sessionStore.loadContextSnapshot(sessionId), {
    resolveImageUrl: (url) => resolveToDataUrl(getImageStore(), url),
    reasoningReplay: activeCacheProfile.reasoningReplay,
    currentProviderId: activeCacheProfile.id
  })

  // 跨回合诊断快照：读回上一轮状态并绑定持久化回调
  const prevDiagState = loadDiagnosticState(sessionsDir, sessionId)
  if (prevDiagState) {
    agentLoop.restoreDiagnosticPersistState(prevDiagState)
  }
  agentLoop.setDiagnosticPersistCallback((state) => {
    saveDiagnosticState(sessionsDir, sessionId, state)
  })

  const checkpointManager = new CheckpointManager({
    checkpointDir: sessionsDir,
    sessionId,
    workspaceRoot: projectPath,
    getActivePathMessageIds: () => {
      const s = sessionStore.load(sessionId)
      if (!s) return undefined
      return new Set(getSessionActiveMessages(s).map((m) => m.id))
    }
  })
  agentLoop.setCheckpointManager(checkpointManager)

  // fork skill 与 task 共用 durable child 执行基座。
  agentLoop.setTurnDispatcher(new TurnDispatcher({
    skillForkRunner: (request) =>
      runSkillFork(
        {
          getSpawnSubagentPort: getSpawnSubagentPort ?? (() => undefined)
        },
        {
          skill: request.skill,
          args: request.args,
          parentSessionId: sessionId,
          parentRunId: runRefs.runId,
          parentMessageId: request.ctx.messageId,
          workingDirectory: request.ctx.workingDir,
          ...(request.ctx.abortSignal ? { abortSignal: request.ctx.abortSignal } : {}),
          templateContext: request.templateContext
        }
      )
  }))

  return {
    eventBus,
    permissionManager,
    toolRegistry,
    agentLoop,
    modelPool,
    checkpointManager,
    skillRegistry,
    artifactStore,
    contextWindow,
    supportsVision,
    frozenPrompt: agentLoop.getFrozenSystemPrompt(),
    runRefs,
    setAskQuestionHandler: (handler) => agentLoop.setAskQuestionHandler(handler)
  }
}
