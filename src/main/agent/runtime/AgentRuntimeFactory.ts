/**
 * AgentRuntimeFactory — 装配单轮执行所需的模型、工具、权限、prompt、cache、memory、skill 与 AgentLoop。
 * 不创建 run、不写用户消息、不决定 XForge stage、不发 terminal。
 */
import { app } from 'electron'
import { join } from 'path'
import {
  AgentLoop,
  EventBus,
  renderToolInventory,
  buildStableSystemPrompt,
  buildSkillContextForMode,
  estimateTokens,
  discoverProjectRules,
  renderBaseRules
} from '../../../runtime/agent'
import { runWorkflow } from '../../../runtime/workflow'
import { runXForgeLiveRuntime } from '../../../runtime/workflow/xforge'
import type { XForgeRunService } from '../../../runtime/workflow/xforge/XForgeRunService'
import { loadModelConfig } from '../../../runtime/model/config'
import { resolveContextWindow, resolveSupportsVision } from '../../../shared/config/types'
import { preferredToolDialect } from '../../../runtime/model/dialect'
import { resolveCacheProfile } from '../../../runtime/model/cacheProfile'
import { OpenAICompatibleModelClient } from '../../../runtime/model/OpenAICompatibleModelClient'
import { ModelClientPool } from '../../../runtime/model/ModelClientPool'
import { ToolRegistry } from '../../../runtime/tools/ToolRegistry'
import { defaultSubAgentPermissionBridge, subAgentBridgeRegistry } from '../../../runtime/tools/subAgentBridge'
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
  buildL1MemoryContext
} from '../../../runtime/memory'
import type { SkillRegistry } from '../../../runtime/skills/SkillRegistry'
import type { RunCoordinator } from '../../../runtime/run/RunCoordinator'
import { getSkillService } from '../../services/SkillServiceHost'
import { getMemoryService } from '../../services/MemoryServiceHost'
import { getWorkspaceService } from '../../services/WorkspaceService'
import { activeStreams } from '../events'
import { resolveToDataUrl } from './imageResolve'
import { registerBuiltinTools } from './registerBuiltinTools'
import { loadDiagnosticState, saveDiagnosticState } from './diagnosticPersistence'

/** 统一 skill 调度开关（默认开启；测试可经环境变量关闭） */
export const USE_UNIFIED_SKILL_DISPATCH = process.env.NOVA_USE_UNIFIED_SKILL_DISPATCH !== 'false'

export interface AgentRuntimeRunRefs {
  runId: string
  executionGeneration: number
  /** 本轮是否在恢复 parked/interrupted XForge */
  resumableXForge: boolean
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
  xforgeService: XForgeRunService
  resumableXForge: boolean
  /** 由 TurnService 预先 ensure 的 cache routing key；factory 不写 session */
  promptCacheKey?: string
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
    xforgeService,
    resumableXForge,
    promptCacheKey
  } = input

  const runRefs: AgentRuntimeRunRefs = {
    runId: '',
    executionGeneration: 0,
    resumableXForge
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
      console.warn('[AgentRuntimeFactory] L1 记忆注入失败，本轮降级跳过:', err)
      memoryContext = null
    }
  }

  const eventBus = new EventBus()
  const permissionManager = new PermissionManager()
  permissionManager.setRules(listPermissionRules(projectPath))
  permissionManager.setCurrentProjectPath(projectPath)
  permissionManager.setSessionId(sessionId)
  permissionManager.setPermissionPolicy(novaSettings.permissionPolicy)

  const toolRegistry = new ToolRegistry()
  // 两阶段局部持有：invoke_skill 创建早于 AgentLoop，执行时惰性读取
  let loop: AgentLoop | null = null

  registerBuiltinTools(toolRegistry, {
    modelClient,
    skillRegistry,
    eventBus,
    contextWindow,
    supportsVision,
    useUnifiedSkillDispatch: USE_UNIFIED_SKILL_DISPATCH,
    getAgentLoop: () => loop,
    getMemoryService,
    loadSettings: loadNovaSettings,
    // 按 run 隔离的子代理权限桥接：装配时 runId 可能尚未分配，延迟到执行期按 runRefs.runId 解析
    getPermissionBridge: () =>
      runRefs.runId
        ? subAgentBridgeRegistry.getOrCreate(runRefs.runId)
        : defaultSubAgentPermissionBridge
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
  const toolSummary = renderToolInventory(toolRegistry.getToolDefinitions(), {
    dialect: toolDialect
  })

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
    useUnifiedSkillDispatch: USE_UNIFIED_SKILL_DISPATCH,
    contextWindow,
    supportsVision,
    maxToolRounds: novaSettings.maxToolRounds,
    toolDialectOverride: persistedConfig?.toolDialect,
    promptCacheKey,
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
  agentLoop.setBashEnvironment({
    binDirs: [join(projectPath, 'node_modules', '.bin')]
  })
  agentLoop.setPermissionManager(permissionManager)
  agentLoop.setMode(session.mode)
  agentLoop.setSkillRegistry(skillRegistry)
  agentLoop.restoreSkillRoots(session.grantedSkillRoots)
  agentLoop.setOnSkillRootAdded((dir) => {
    sessionStore.addGrantedSkillRoot(sessionId, dir)
  })
  agentLoop.setSkillForkDeps({
    modelClient,
    parentEventBus: eventBus,
    resolveTool: (name) => toolRegistry.getTool(name),
    contextWindow,
    supportsVision
  })
  agentLoop.setSessionContext(sessionStore, sessionId)
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

  agentLoop.setWorkflowRunner(async (scriptName, args, opts) => {
    if (session.mode !== 'compose') {
      getWorkspaceService().setMode({ mode: 'compose', sessionId })
      agentLoop.setMode('compose')
    }
    permissionManager.setPermissionPolicy('auto')

    const outcome = await runWorkflow({
      script: scriptName,
      args: { requirement: args, task: args },
      abortSignal: opts?.abortSignal,
      assertExecutionCurrent: () =>
        !runRefs.runId ||
        runRefs.executionGeneration === 0 ||
        runCoordinator.isExecutionCurrent(runRefs.runId, runRefs.executionGeneration),
      deps: {
        modelClient,
        parentEventBus: eventBus,
        resolveTool: (name) => toolRegistry.getTool(name),
        resolveSkill: (name) => skillRegistry.get(name),
        workspaceRoot: projectPath,
        // 按 run 隔离的子代理桥接（运行期 runRefs.runId 已分配）
        permissionBridge: runRefs.runId
          ? subAgentBridgeRegistry.getOrCreate(runRefs.runId)
          : defaultSubAgentPermissionBridge,
        checkpointManager,
        contextWindow,
        supportsVision,
        mode: 'compose',
        sessionId
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

  agentLoop.setXForgeRunner(async (request, opts) => {
    const persistedGoal = runCoordinator
      .getSnapshot(runRefs.runId)
      ?.xforge?.mainSession.goal.trim()
    const result = await runXForgeLiveRuntime({
      runId: runRefs.runId,
      request: persistedGoal || request,
      explicitFullDev: opts.explicitFullDev,
      workspaceRoot: projectPath,
      modelClient: modelPool,
      parentEventBus: eventBus,
      parentMessageId: opts.messageId,
      toolRegistry,
      skillRegistry,
      checkpointManager,
      committer: xforgeService.createExecutionCommitter(runRefs.executionGeneration),
      askQuestion: askQuestionHandler,
      abortSignal: opts.abortSignal,
      assertExecutionCurrent: () =>
        runCoordinator.isExecutionCurrent(runRefs.runId, runRefs.executionGeneration),
      contextWindow,
      supportsVision,
      readState,
      initializeWorkspaceBaseline: !runRefs.resumableXForge
    })
    return { summary: result.summary }
  })

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
    frozenPrompt,
    runRefs,
    setAskQuestionHandler: (handler) => agentLoop.setAskQuestionHandler(handler)
  }
}
