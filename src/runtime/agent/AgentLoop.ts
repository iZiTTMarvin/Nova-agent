/**
 * AgentLoop — 核心消息-模型-工具循环的门面类。
 * 接收用户消息，组织上下文，调用模型，处理工具调用，通过 EventBus 向外发射流式事件。
 * 纯循环驱动已下沉到 runAgentLoop，本类负责服务装配和消息生命周期收尾。
 */
import type { ModelClient } from '../model/ModelClient'
import { ModelClientPool } from '../model/ModelClientPool'
import type { ChatMessage, ChatToolCall, ContentBlock, ToolDefinition } from '../model/types'
import { extractTextFromContent } from '../model/types'
import type { AgentState, AgentLoopConfig } from './types'
import { ToolRegistry } from '../tools/ToolRegistry'
import type { CheckpointManager } from '../checkpoints/CheckpointManager'
import type { PermissionManager } from '../permissions/PermissionManager'
import {
  PermissionCoordinator,
  type ToolAuthorizationPolicy
} from '../permissions/PermissionCoordinator'
import type { SessionStore } from '../sessions/SessionStore'
import type { Mode } from '../../shared/session/types'
import type { TruncationStage } from '../tools/grep-types'
import { createTruncationPipeline } from '../tools/TruncationPipeline'
import { EventBus } from './EventBus'
import { createProductionContextBudgetManager, type ContextBudgetManager } from './ContextBudgetManager'
import { CacheDiagnostics } from '../model/cacheDiagnostics'
import { randomUUID } from 'crypto'
import { executeToolBatch } from './execution/toolBatchExecutor'
import { IdleCompressionTimer } from './compaction/IdleCompressionTimer'
import type { IdleCompactionTarget } from './compaction/IdleCompressionTimer'
import type { IdleCompactionScheduleState } from './compaction/compaction'
import { resolveCacheProfile } from '../model/cacheProfile'
import { HookManager } from './core/HookManager'
import { RecoveryStateMachine } from './recovery/RecoveryStateMachine'
import { SystemPromptBuilder } from './promptBuilder/SystemPromptBuilder'
import { buildSessionContext } from './context/sessionContext'
import { calculateContextBreakdown } from './context/contextBreakdownCalculator'
import { preferredToolDialect, type ToolDialect } from '../model/dialect'
import { createReadState, type ReadState } from '../tools/editTool'
import type { ArtifactStore } from '../artifacts/ArtifactStore'
import type { AskQuestionItem, AskQuestionAnswer } from '../../shared/askQuestion/types'
import type { FileEffectRecorder, ToolContext } from '../tools/types'
import { isReadablePlanInWorkspace } from '../plans'

import { TurnDispatcher } from './turn'
import type { AgentTurnRoute, AgentTurnOutcome } from './turn'
import { getModeInstruction } from './promptBuilder/modeInstruction'
import { createAgentContext, getEffectiveToolDefinitions, type AgentContext } from './core/AgentContext'
import { StreamProcessor } from './stream/StreamProcessor'
import { runAgentLoop, type LoopEndResult } from './core/runAgentLoop'
import { CompactionService } from './compaction/CompactionService'
import { createToolPostProcessExtension } from './extensions/toolPostProcessExtension'
import { StopPolicyExtension } from './extensions/stopPolicyExtension'
import type { AgentLoopConfig as LoopConfig } from './core/loopTypes'

export class AgentLoop implements IdleCompactionTarget {
  /** 模型客户端池，统一包装成 ModelClientPool（即使无 fallback 也包一层，对外接口不变） */
  private modelPool: ModelClientPool
  private eventBus: EventBus
  private config: AgentLoopConfig
  private state: AgentState = 'idle'
  /** 独立的取消标志，因为 cancel() 可从外部异步调用，TS 控制流无法感知 */
  private cancelled = false
  private abortController: AbortController | null = null

  /**
   * 标准化状态容器。
   * 下列字段通过访问器桥接到 this.ctx.*，让旧使用点（this.context / this.workingDir 等）
   * 一行不动。Facade 级态（state/cancelled/modelPool/eventBus/...）仍保留为实例字段。
   */
  private ctx: AgentContext = createAgentContext({ readState: createReadState() })

  /** 对话上下文：累积所有消息用于下一次模型调用 */
  private get context(): ChatMessage[] {
    return this.ctx.messages
  }
  private set context(value: ChatMessage[]) {
    this.ctx.messages = value
  }

  /** 工具注册表 */
  private get toolRegistry(): ToolRegistry | null {
    return this.ctx.toolRegistry
  }
  private set toolRegistry(value: ToolRegistry | null) {
    this.ctx.toolRegistry = value
  }

  /** 工作区路径（传入后工具执行才有工作区边界） */
  private get workingDir(): string | null {
    return this.ctx.workingDir
  }
  private set workingDir(value: string | null) {
    this.ctx.workingDir = value
  }

  /** bash 工具的自定义 shell 路径（可选） */
  private get shellPath(): string | undefined {
    return this.ctx.shellPath
  }
  private set shellPath(value: string | undefined) {
    this.ctx.shellPath = value
  }

  /** bash 工具的 PATH 注入目录（可选） */
  private get binDirs(): string[] {
    return this.ctx.binDirs
  }
  private set binDirs(value: string[]) {
    this.ctx.binDirs = value
  }

  /** 运行模式（plan / default / auto） */
  private get mode(): Mode {
    return this.ctx.mode
  }
  private set mode(value: Mode) {
    this.ctx.mode = value
  }

  /** checkpoint 管理器（可选） */
  private checkpointManager: CheckpointManager | null = null
  private fileEffectRecorder: FileEffectRecorder | null = null
  /** 当前工具调用方言，由模型 ID 决定 */
  private get toolDialect(): ToolDialect {
    return this.ctx.dialect
  }
  private set toolDialect(value: ToolDialect) {
    this.ctx.dialect = value
  }

  /** 权限交互协调器：规则判定委托 PermissionManager，pending resolver 的唯一 owner */
  private readonly permissionCoordinator: PermissionCoordinator

  /** 会话级状态存储（透传给 todo_write 等需要写会话元数据的工具） */
  private get sessionStore(): SessionStore | null {
    return this.ctx.sessionStore
  }
  private set sessionStore(value: SessionStore | null) {
    this.ctx.sessionStore = value
  }

  /** 当前会话 ID，与 sessionStore 配套 */
  private get sessionId(): string | null {
    return this.ctx.sessionId
  }
  private set sessionId(value: string | null) {
    this.ctx.sessionId = value
  }

  /** 会话级 artifact 存储（大输出落盘，透传给工具执行层） */
  private get artifactStore(): ArtifactStore | null {
    return this.ctx.artifactStore
  }
  private set artifactStore(value: ArtifactStore | null) {
    this.ctx.artifactStore = value
  }

  /** 技能正文层独立 token 估算，作为'技能'分项桶的预算 */
  private get skillsTokenBudget(): number {
    return this.ctx.skillsTokenBudget
  }
  private set skillsTokenBudget(value: number) {
    this.ctx.skillsTokenBudget = value
  }

  /** 最大工具调用轮数（可动态调整） */
  private maxToolRounds: number

  /** 生产路径上下文硬预算（按 contextWindow 配置） */
  private contextBudgetManager: ContextBudgetManager

  /** 活跃轮次压缩与压缩簿记的唯一 owner */
  private readonly compactionService: CompactionService

  /** 缓存诊断跟踪器：检测 system prompt / 工具定义变化导致的缓存失效 */
  private cacheDiagnostics = new CacheDiagnostics()

  /** 截断管道：用于工具输出超限时进行结构化截断 */
  private truncationPipeline = createTruncationPipeline()

  /** 压缩簿记只读桥接；写入由 CompactionService 统一完成。 */
  private get lastEstimatedTokens(): number {
    return this.compactionService.getLastEstimatedTokens()
  }
  private get userTurnsSinceCompaction(): number {
    return this.compactionService.getUserTurnsSinceCompaction()
  }
  private get compactionLevel(): number {
    return this.compactionService.getCompactionLevel()
  }

  /** 空闲压缩计时器（惰性创建） */
  private idleTimer: IdleCompressionTimer | null = null
  /** 是否已有进行中的空闲压缩（供 shouldScheduleIdleCompaction 预筛） */
  private idleCompactionInProgress = false
  /** dispose 后阻断空闲压缩调度 */
  private disposed = false

  /** Hook 编排层（与 EventBus 并行，负责干预） */
  private hookManager: HookManager

  /**
   * StreamProcessor：流消费 / 事件发射 / 方言策略 / 三层兜底解析 /
   * 重试 / 降级 / 溢出压缩全部下沉至此。惰性创建以复用当前 modelPool / recovery /
   * cacheDiagnostics / hookManager / eventBus。
   */
  private streamProcessor: StreamProcessor | null = null
  private getStreamProcessor(): StreamProcessor {
    if (!this.streamProcessor) {
      this.streamProcessor = new StreamProcessor({
        modelPool: this.modelPool,
        recovery: this.recovery,
        cacheDiagnostics: this.cacheDiagnostics,
        emit: (event) => this.eventBus.emit(event),
        emitContextBreakdown: (messageId, promptTokens) => this.emitContextBreakdown(messageId, promptTokens),
        runOverflowCompaction: (mode) =>
          this.compactionService.runOverflowCompaction(mode, this.abortController?.signal),
        hookManager: this.hookManager,
        promptCacheKey: this.config.promptCacheKey,
        syncToolDialect: (context) => {
          this.syncToolDialectFromActiveProvider()
          context.dialect = this.toolDialect
        }
      })
    }
    return this.streamProcessor
  }

  /**
   * 按 ModelClientPool 当前 active provider 重算工具方言。
   * fallback 切换后必须调用，避免沿用主模型 dialect。
   */
  private syncToolDialectFromActiveProvider(): void {
    const provider = this.modelPool.getActiveProvider()
    const override = this.config.toolDialectOverride ?? provider.toolDialect
    this.toolDialect = preferredToolDialect(
      provider.modelId,
      provider.baseUrl,
      override
    )
  }

  /**
   * StopPolicyExtension：熔断计数 + maxRounds 提示。
   * 实例态持有熔断计数 Map，每条用户消息开始时 clear()。
   */
  private readonly stopPolicy = new StopPolicyExtension()

  /** 错误恢复状态机 */
  private recovery = new RecoveryStateMachine()

  /** 冻结的 system prompt（6 层拼装结果） */
  private get frozenSystemPrompt(): string {
    return this.ctx.systemPrompt
  }
  private set frozenSystemPrompt(value: string) {
    this.ctx.systemPrompt = value
  }

  /** 当前轮次 messageId（cancel / onCancel 使用） */
  private currentMessageId: string | null = null

  /**
   * 本会话已触发 skill 的目录集合，随 executeBatch 透传给只读工具。
   * 写入口仅限 addSkillRoot（inject / fork / invoke_skill），不接受模型参数直接注入。
   * 实例内累积；跨轮由宿主从 session.grantedSkillRoots 经 restoreSkillRoots 恢复，
   * 新登记经 onSkillRootAdded 写回会话元数据。
   */
  private skillRoots = new Set<string>()
  /** 新 skill 根登记时通知宿主持久化（restore 路径不触发） */
  private onSkillRootAdded: ((dir: string) => void) | null = null
  /**
   * 产品分派器：按已解析 route 调用 XForge / Workflow / Fork 执行器。
   * 默认无执行器（仅 agent route 可用，供子 agent / 测试裸构造）；
   * 宿主（AgentRuntimeFactory / 测试）通过 setTurnDispatcher 装配完整执行器。
   * dispatcher 只返回数据，不拥有生命周期；abortSignal 在分派时透传——
   * 停止按钮 → cancel() → abortController.abort()，执行器必须消费该信号才能真正终止。
   */
  private turnDispatcher = new TurnDispatcher({})
  private modeInstructionProvider: (() => string) | null = null

  /**
   * 执行 generation fencing：副作用前校验（由 agentHandler 注入）。
   * 绑定当前 runId/generation；grace 超时或 interrupted 后拒绝写文件与 checkpoint。
   */
  private assertExecutionCurrent: (() => boolean) | null = null

  /**
   * askQuestion 阻塞回调（可选）。
   * 由 agentHandler 通过 setAskQuestionHandler 注入；executeBatch 时透传给
   * toolBatchExecutor → ToolContext.askQuestion，供 askQuestion 工具发起提问。
   * 不调用时 askQuestion 工具降级为 no-op，主要用于子 agent / 测试场景。
   */
  private askQuestionHandler?: (requestId: string, questions: AskQuestionItem[]) => Promise<AskQuestionAnswer[]>
  /** 经 PermissionManager 批准后，由宿主同步会话、WorkspaceService 与当前循环。 */
  private switchModeHandler?: ToolContext['switchMode']
  /** 本轮构造时捕获的 active plan；计划正文仍以工作区文件为真源。 */
  private activePlanPath?: string

  /**
   * 文件读取状态：记录"已 read 过哪些文件"，edit/write 工具的"先读后改"校验依赖此。
   * 默认实例化一个独立的 readState；agentHandler 注入主 readState（跨 SEND_MESSAGE 复用），
   * sub agent 在 taskTool / runSkillFork 中 clone 主 readState 隔离。
   */
  private get readState(): ReadState {
    return this.ctx.readState
  }
  private set readState(value: ReadState) {
    this.ctx.readState = value
  }

  constructor(
    modelClient: ModelClient | ModelClientPool,
    eventBus: EventBus,
    config?: AgentLoopConfig
  ) {
    // 统一包装成 ModelClientPool（单个 ModelClient 时无 fallback）
    // 从 client 自身的 config 读取 modelId/baseUrl 用于 dialect 判定
    const clientConfig = (modelClient as { config?: { modelId?: string; baseUrl?: string } }).config
    this.modelPool = modelClient instanceof ModelClientPool
      ? modelClient
      : new ModelClientPool({
        primary: modelClient,
        primaryConfig: {
          baseUrl: clientConfig?.baseUrl ?? '',
          apiKey: '',
          modelId: clientConfig?.modelId ?? 'primary'
        }
      })
    this.eventBus = eventBus
    this.permissionCoordinator = new PermissionCoordinator({
      emit: (event) => this.eventBus.emit(event),
      getMode: () => this.mode
    })
    this.config = {
      systemPrompt: config?.systemPrompt ?? '你是 Nova 的编程助手。',
      systemPromptLayers: config?.systemPromptLayers,
      maxToolRounds: config?.maxToolRounds ?? 20,
      contextWindow: config?.contextWindow,
      supportsVision: config?.supportsVision ?? true,
      toolExecution: config?.toolExecution ?? 'parallel',
      maxParallelToolCalls: Math.max(1, config?.maxParallelToolCalls ?? 4),
      onCompaction: config?.onCompaction,
      skillsTokenEstimate: config?.skillsTokenEstimate,
      toolDialectOverride: config?.toolDialectOverride,
      promptCacheKey: config?.promptCacheKey
    }
    // 按当前 active provider 判定方言；fallback 切换后由 StreamProcessor 重算
    this.syncToolDialectFromActiveProvider()
    /** 技能正文独立 token 桶（来自 skillContext 拼装时一次性估算） */
    this.skillsTokenBudget = Math.max(0, config?.skillsTokenEstimate ?? 0)
    this.maxToolRounds = this.config.maxToolRounds ?? 20
    this.contextBudgetManager = createProductionContextBudgetManager({
      contextWindow: this.config.contextWindow ?? 200_000
    })
    this.compactionService = new CompactionService({
      context: this.ctx,
      modelClient: this.modelPool,
      contextBudgetManager: this.contextBudgetManager,
      cacheDiagnostics: this.cacheDiagnostics,
      contextWindow: this.config.contextWindow ?? 200_000,
      promptCacheKey: this.config.promptCacheKey,
      onCompaction: this.config.onCompaction
    })
    this.hookManager = new HookManager(eventBus)
    this.frozenSystemPrompt = this.buildFrozenSystemPrompt()

    if (this.frozenSystemPrompt) {
      this.context.push({
        role: 'system',
        content: this.frozenSystemPrompt
      })
    }
  }
  /** 从配置构建冻结 system prompt（根据模型方言注入工具目录格式） */
  private buildFrozenSystemPrompt(): string {
    const layers = this.config.systemPromptLayers
    if (layers) {
      return SystemPromptBuilder.build({
        agentRole: layers.agentRole,
        baseRules: layers.baseRules ?? '',
        projectRules: layers.projectRules ?? '',
        memoryContext: layers.memoryContext ?? '',
        skillContext: layers.skillContext ?? '',
        modeInstruction: layers.modeInstruction ?? '',
        toolSummary: layers.toolSummary ?? ''
      })
    }
    return this.config.systemPrompt ?? ''
  }

  /** 返回当前应使用的工具调用方言 */
  getToolDialect(): ToolDialect {
    return this.toolDialect
  }

  /**
   * 计算本轮 prompt 的分项 token 估算并推 context_breakdown 事件。
   * 复用 contextBreakdownCalculator，保证 AgentLoop 内外口径一致。
   */
  private emitContextBreakdown(messageId: string, promptTokensActual: number): void {
    const result = calculateContextBreakdown({
      session: {
        id: this.sessionId ?? '',
        workspaceRoot: this.workingDir ?? '',
        mode: this.mode ?? 'default',
        messages: [],
        currentLeafId: null,
        frozenSystemPrompt: this.frozenSystemPrompt,
        schemaVersion: 2,
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      runtimeMessages: this.context.filter(m => m.role !== 'system'),
      skills: this.skillsTokenBudget,
      toolDefinitions: getEffectiveToolDefinitions(this.ctx),
      contextLimit: this.config.contextWindow ?? 200_000
    })
    this.eventBus.emit({
      ...result.payload,
      type: 'context_breakdown',
      messageId,
      promptTokensActual
    })
  }

  /** 注入自定义 HookManager（测试 / 扩展用） */
  setHookManager(hm: HookManager): void {
    this.hookManager = hm
  }

  /** 获取 HookManager 实例 */
  getHookManager(): HookManager {
    return this.hookManager
  }

  /**
   * 注入历史对话上下文（放在 system prompt 之后）
   * 用于每次 send-message 时从 session 恢复多轮历史
   */
  injectHistory(messages: ChatMessage[]): void {
    // 历史消息插入到 system prompt 之后
    // this.context[0] 是 system prompt（如果配置了的话），后续是历史
    this.context = [
      ...this.context,
      ...messages
    ]
    // 恢复历史后立即推送一次上下文占用，让 renderer 无需等待下一轮 LLM 调用即可显示
    this.emitContextBreakdown('', 0)
  }

  /**
   * 用上下文快照恢复压缩态运行时上下文。
   * 与 injectHistory 二选一：有可用快照走本方法，否则走 injectHistory。
   * @param summary 快照里的摘要原文
   * @param recentMessages 快照的非 system 消息 + 锚点之后的增量消息（已拼好）
   * @param compactionLevel 快照记录的压缩层级
   */
  restoreCompactedContext(summary: string, recentMessages: ChatMessage[], compactionLevel: number): void {
    this.compactionService.restoreCompactedContext(summary, recentMessages, compactionLevel)
    this.emitContextBreakdown('', 0)
  }

  /** 设置工具注册表 */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry
  }

  /** 设置本轮实际暴露给模型、缓存诊断和上下文拆分的工具定义来源。 */
  setEffectiveToolDefinitionsProvider(provider: (() => ToolDefinition[]) | null): void {
    this.ctx.effectiveToolDefinitions = provider
  }

  /** 外部触发 epoch 切换（如 XForge 阶段切换导致工具集变化） */
  bumpCacheEpoch(reason: import('../model/cacheDiagnostics').EpochReason): void {
    this.cacheDiagnostics.bumpEpoch(reason)
  }

  /** 导出缓存诊断状态（供跨回合持久化） */
  getDiagnosticPersistState(): import('../model/cacheDiagnostics').DiagnosticPersistState {
    return this.cacheDiagnostics.getPersistState()
  }

  /** 从持久化状态恢复缓存诊断（loop 重建后调用） */
  restoreDiagnosticPersistState(state: import('../model/cacheDiagnostics').DiagnosticPersistState): void {
    this.cacheDiagnostics.restoreFromState(state)
  }

  /** 设置诊断状态持久化回调（每次快照更新后触发） */
  setDiagnosticPersistCallback(cb: ((state: import('../model/cacheDiagnostics').DiagnosticPersistState) => void) | null): void {
    this.cacheDiagnostics.setPersistCallback(cb)
  }

  setModeInstructionProvider(provider: (() => string) | null): void {
    this.modeInstructionProvider = provider
  }

  /** 设置工作区路径（工具执行时的边界目录） */
  setWorkingDir(dir: string): void {
    this.workingDir = dir
    // 无须显式重置 session context：getSessionContextPrefix 扫描 context 时会
    // 发现旧锚点的 Working directory ≠ 新 dir，自动触发重新拼接。
  }

  /** 绑定当前 runId；写者租约 / 子代理权限按 run 归属时由工具读取。 */
  setRunRef(runId: string): void {
    this.ctx.runId = runId
  }

  /** 绑定工作区根（与 workingDir 同义，专门给写者租约按工作区分桶）。 */
  setWorkspaceRoot(root: string): void {
    this.ctx.workspaceRoot = root
  }

  /**
   * 设置 bash 工具的执行环境（可选）。
   *
   * - shellPath：覆盖默认 Shell 发现
   * - binDirs：注入到 PATH 前面的目录列表
   *
   * 透传给 ToolContext，由 bash 工具读取。
   * 同时清空 bashTool.description 的懒缓存，让新 shellPath 生效。
   */
  setBashEnvironment(env: { shellPath?: string; binDirs?: string[] } = {}): void {
    this.shellPath = env.shellPath
    this.binDirs = env.binDirs ?? []
    if (env.shellPath) {
      // 动态 import 避免循环依赖（agent → tools → shellConfig 不会反向）
      import('../tools/bash').then((mod) => mod.invalidateBashDescriptionCache?.())
    }
  }

  /** 设置运行模式 */
  setMode(mode: Mode): void {
    this.mode = mode
  }

  /** 设置 checkpoint 管理器 */
  setCheckpointManager(manager: CheckpointManager): void {
    this.checkpointManager = manager
  }

  /** 设置权限决策引擎 */
  setPermissionManager(manager: PermissionManager): void {
    this.permissionCoordinator.setPermissionManager(manager)
  }

  /** 注入写工具使用的持久化副作用协议。 */
  setFileEffectRecorder(recorder: FileEffectRecorder | null): void {
    this.fileEffectRecorder = recorder
  }

  /**
   * 叠加在基础 PermissionManager 之前的运行时权限策略。
   * 用于阶段工作流等更窄的能力边界；拒绝项不会再弹基础权限确认。
   */
  setToolAuthorizationPolicy(policy: ToolAuthorizationPolicy | null): void {
    this.permissionCoordinator.setToolAuthorizationPolicy(policy)
  }

  /**
   * 设置会话上下文：把 SessionStore 与当前 sessionId 注入 AgentLoop，
   * 工具执行时由 toolBatchExecutor 透传到 ToolContext。
   * todo_write 等需要写会话元数据的工具会用到；其他工具不受影响。
   */
  setSessionContext(sessionStore: SessionStore, sessionId: string): void {
    this.sessionStore = sessionStore
    this.sessionId = sessionId
  }

  /** 注入会话级 artifact 存储，供 bash / grep / read 大输出落盘 */
  setArtifactStore(store: ArtifactStore): void {
    this.artifactStore = store
  }

  /** 动态调整最大工具调用轮数 */
  setMaxToolRounds(n: number): void {
    this.maxToolRounds = n
  }


  /**
   * 注册一个 skill 目录为额外可读根（skill inject / fork / invoke_skill 工具触发时调用）。
   * 空串 / 空白忽略；幂等（Set）。
   * 新登记时回调 onSkillRootAdded，供宿主写入 session.grantedSkillRoots。
   */
  addSkillRoot(dir: string): void {
    const trimmed = dir.trim()
    if (!trimmed) return
    if (this.skillRoots.has(trimmed)) return
    this.skillRoots.add(trimmed)
    this.onSkillRootAdded?.(trimmed)
  }

  /** 批量恢复会话级已授权 skill 根（不触发持久化回调，避免写放大） */
  restoreSkillRoots(dirs: string[] | undefined | null): void {
    if (!dirs || dirs.length === 0) return
    for (const dir of dirs) {
      const trimmed = dir.trim()
      if (trimmed) this.skillRoots.add(trimmed)
    }
  }

  /** 当前已登记的 skill 可读根（只读快照） */
  getSkillRoots(): string[] {
    return [...this.skillRoots]
  }

  /**
   * 新 skill 根登记时的持久化钩子（如写入 SessionStore.grantedSkillRoots）。
   * restoreSkillRoots 不会触发此回调。
   */
  setOnSkillRootAdded(cb: ((dir: string) => void) | null): void {
    this.onSkillRootAdded = cb
  }

  /** 装配产品分派器（XForge / Workflow / Fork 执行器由宿主构造） */
  setTurnDispatcher(dispatcher: TurnDispatcher): void {
    this.turnDispatcher = dispatcher
  }

  /**
   * 注入主 readState（由 agentHandler 调用，跨 SEND_MESSAGE 复用）。
   * 不调用时使用 loop 自带的独立实例（用于 sub agent 隔离测试）。
   */
  setReadState(rs: ReadState): void {
    this.readState = rs
  }

  /**
   * 注入 askQuestion 阻塞回调（由 agentHandler 调用）。
   * 不调用时 askQuestion 工具降级为 no-op，主要用于子 agent / 测试场景。
   */
  setAskQuestionHandler(
    handler: (requestId: string, questions: AskQuestionItem[]) => Promise<AskQuestionAnswer[]>
  ): void {
    this.askQuestionHandler = handler
  }

  setSwitchModeHandler(handler: NonNullable<ToolContext['switchMode']>): void {
    this.switchModeHandler = handler
  }

  setActivePlanPath(path: string | undefined): void {
    this.activePlanPath = path
  }

  private getCurrentModeInstruction(): string {
    const hasReadableActivePlan =
      !!this.workingDir &&
      isReadablePlanInWorkspace(this.workingDir, this.activePlanPath)
    return (
      this.modeInstructionProvider?.() ??
      getModeInstruction(this.mode, {
        ...(hasReadableActivePlan ? { activePlanPath: this.activePlanPath } : {})
      })
    )
  }

  /**
   * 注入执行 generation fencing（由 agentHandler 在 bindExecutionGeneration 后调用）。
   * 不注入时工具/checkpoint 仅依赖 abortSignal（单测 / 子 agent 场景）。
   */
  setExecutionFence(assertCurrent: () => boolean): void {
    this.assertExecutionCurrent = assertCurrent
  }

  /** 获取当前 readState（供 toolBatchExecutor 注入到 ToolContext） */
  getReadState(): ReadState {
    return this.readState
  }

  /**
   * 克隆当前 readState 的深拷贝，供 sub agent（task / skill fork）创建独立副本。
   * 主 agent 与 sub agent 共享 readState 会导致：
   *   - sub agent 读过的文件污染主 agent 后续 edit 校验；
   *   - 主 agent 的 readState 被修改后再创建 sub agent 时复用陈旧状态。
   */
  cloneReadState(): ReadState {
    return this.readState.clone()
  }

  /** 获取当前状态 */
  getState(): AgentState {
    return this.state
  }

  /** 获取事件总线实例 */
  getEventBus(): EventBus {
    return this.eventBus
  }

  /** 获取当前对话上下文的快照 */
  getContext(): ChatMessage[] {
    return [...this.context]
  }

  /**
   * 发送用户消息并启动循环。
   * 发射 message_start → (流式 text_delta / tool_call / tool_result) → 终态事件。
   * route 由调用方在 startRun 前通过 resolveAgentTurnRoute 解析，本方法不再自行解析。
   *
   * 终态契约：轮次一旦开始，所有成功 / 取消 / 失败路径都经 finalizeTurn 统一收尾，
   * resolve 为结构化 AgentTurnOutcome；仅轮次副作用前的装配校验失败会 reject。
   */
  async sendMessage(content: string | ContentBlock[], route: AgentTurnRoute): Promise<AgentTurnOutcome> {
    if (this.state === 'running') {
      const busy = '当前正在执行中，请先取消'
      this.eventBus.emit({ type: 'error', messageId: '', error: busy })
      return { status: 'failed', error: new Error(busy) }
    }

    // 执行能力校验：必须在任何轮次副作用（state/checkpoint/message_start/hook）之前。
    // 非 agent route 缺少对应执行器时 fail closed，避免留下半开生命周期。
    this.assertRouteExecutable(route)

    const messageId = randomUUID()
    this.currentMessageId = messageId
    this.state = 'running'
    this.cancelled = false
    this.abortController = new AbortController()
    this.stopPolicy.clear()
    // 重试/降级/溢出压缩的单轮态由 StreamProcessor 自持，每条新消息开始时重置。
    // retry 重跑本轮时不重置——重试计数跨 retry 累积。
    this.getStreamProcessor().resetRetryState()
    // 每条新消息开始时重置回主模型（降级不影响下一轮）
    this.modelPool.resetToPrimary()

    // 空闲压缩：新消息到达时取消任何正在运行的压缩
    this.idleTimer?.cancel()

    // 显式记录 checkpoint 事务是否已开始：begin 前失败的轮次不得调用 endMessage
    let checkpointBegun = false
    let outcome: AgentTurnOutcome

    try {
      // 开启 checkpoint 事务边界（generation 失效时拒绝，避免假终止后仍建快照）
      if (this.assertExecutionCurrent && !this.assertExecutionCurrent()) {
        throw new Error('checkpoint 被拒绝：执行 generation 已失效')
      }
      this.checkpointManager?.beginMessage(messageId)
      checkpointBegun = true

      this.eventBus.emit({ type: 'message_start', messageId })

      outcome = await this.runTurn(content, route, messageId)
    } catch (err) {
      if (this.cancelled) {
        // 取消引发的执行中断（abort 拒绝等）按取消收尾，不伪装成失败
        outcome = { status: 'cancelled' }
      } else {
        const error = err instanceof Error ? err : new Error(String(err))
        // 模型终态错误的 onError 已在 StreamProcessor / runAgentLoop 内触发；
        // 此处只覆盖分派执行器、hook、checkpoint begin 等抛出路径。
        await this.notifyErrorHook(messageId, error.message)
        outcome = { status: 'failed', error }
      }
    }

    return this.finalizeTurn(messageId, outcome, checkpointBegun)
  }

  /**
   * 执行一轮消息的产品路径：按已解析 route 分派到 XForge / Workflow / Fork 执行器，
   * 或准备上下文进入 Agent kernel。只返回轮次结果，不做任何终态收尾——
   * checkpoint、终态事件、state 与 idle timer 统一由 finalizeTurn 处理。
   */
  private async runTurn(
    content: string | ContentBlock[],
    route: AgentTurnRoute,
    messageId: string
  ): Promise<AgentTurnOutcome> {
    const modeInstruction = this.getCurrentModeInstruction()
    let userText = typeof content === 'string'
      ? content
      : extractTextFromContent(content)

    // Session context 前缀（合并方案）：只在当前上下文里不存在"仍有效的锚点"时拼接，
    // 并放到本轮 user 消息 content 最前面。它是真实 user 消息的一部分（不标
    // internal），模型能真正看到；不落盘（持久化在 agentHandler 中用原始 content，
    // 早于 sendMessage）。null 表示当前 context 已有有效锚点，跳过。
    const sessionPrefix = this.getSessionContextPrefix()
    /** 把 sessionPrefix 拼到一段文本前（prefix 为空时原样返回） */
    const withPrefix = (text: string): string =>
      sessionPrefix ? `${sessionPrefix}\n\n${text}` : text

    await this.hookManager.trigger({ event: 'onMessageStart', messageId, text: userText })

    // 编排入口自动切入 compose：模式归 AgentLoop 所有，dispatcher 不修改状态
    if (route.kind === 'workflow' && this.mode !== 'compose') {
      this.setMode('compose')
    }

    // 产品分派下沉到 TurnDispatcher（路由在 startRun 前由 resolveAgentTurnRoute 确定）。
    // dispatcher 只返回数据；上下文写入、事件与终态仍由本类持有。
    const dispatched = await this.turnDispatcher.dispatch(content, route, {
      messageId,
      abortSignal: this.abortController?.signal,
      fork: {
        workingDir: this.workingDir ?? process.cwd(),
        readState: this.readState,
        shellPath: this.shellPath,
        binDirs: this.binDirs,
        workspacePath: this.workingDir ?? undefined
      }
    })

    if (dispatched.kind === 'handled') {
      // 执行器已完成产品路径：摘要写入上下文并推给 UI，不进入 Agent kernel
      this.context.push({ role: 'assistant', content: dispatched.assistantSummary })
      this.eventBus.emit({ type: 'text_delta', messageId, delta: dispatched.assistantSummary })
      return this.settledTurnOutcome()
    }

    // continue：按规范化输入准备上下文，然后进入 runAgentLoop
    if (dispatched.grantedSkillRoot) {
      // slash / 自动路由 inject：把该 skill 目录登记为额外只读根
      this.addSkillRoot(dispatched.grantedSkillRoot)
    }
    if (dispatched.assistantPrelude !== undefined) {
      this.context.push({ role: 'assistant', content: dispatched.assistantPrelude })
    }
    userText = dispatched.userText
    if (typeof dispatched.userContent === 'string') {
      this.context.push({
        role: 'user',
        content: withPrefix(`${dispatched.userContent}\n\n${modeInstruction}`)
      })
    } else {
      // ContentBlock[]（含图片）：sessionPrefix 作为首个 text block 插入最前面
      const blocks = sessionPrefix
        ? [{ type: 'text' as const, text: sessionPrefix }, ...dispatched.userContent, { type: 'text' as const, text: modeInstruction }]
        : [...dispatched.userContent, { type: 'text' as const, text: modeInstruction }]
      this.context.push({ role: 'user', content: blocks })
    }

    // 此处只估算，不抛硬预算：阈值压缩在 runAgentLoop 内先于模型调用执行。
    // 硬上限在压缩之后、发模型之前套用（见 runAgentLoop），避免大历史无法进入压缩。
    this.compactionService.recordUserTurn()

    // 主循环下沉到 runAgentLoop：hooks → compaction → StreamProcessor → assistant 续接 → executeBatch → shouldStopAfterTurn。
    // Facade 负责：装配循环依赖、构建 executeBatch（注入权限/截断 extension）、
    // 收尾（终态错误 / cancelled → finishMessageRound）。
    const executeBatch = (toolCalls: ChatToolCall[], mid: string) =>
      executeToolBatch({
        toolCalls,
        messageId: mid,
      toolRegistry: this.toolRegistry,
      workingDir: this.workingDir ?? process.cwd(),
      runId: this.ctx.runId ?? undefined,
      workspaceRoot: this.ctx.workspaceRoot ?? undefined,
      mode: this.mode,
        shellPath: this.shellPath,
        binDirs: this.binDirs,
        supportsVision: this.config.supportsVision ?? true,
        checkpointManager: this.checkpointManager,
        fileEffectRecorder: this.fileEffectRecorder,
        abortSignal: this.abortController?.signal,
        checkPermission: (toolName, args, msgId, toolCallId) =>
          this.permissionCoordinator.checkPermission(toolName, args, msgId, toolCallId),
        checkBatchPermission: (items, msgId) =>
          this.permissionCoordinator.checkBatchPermission(items, msgId),
        emit: (event) => this.eventBus.emit(event),
        applyTruncation: createToolPostProcessExtension(this),
        maxParallelToolCalls: this.config.maxParallelToolCalls ?? 4,
        toolExecution: this.config.toolExecution ?? 'parallel',
        sessionStore: this.sessionStore,
        sessionId: this.sessionId,
        eventBus: this.eventBus,
        hookManager: this.hookManager,
        readState: this.readState,
        artifactStore: this.artifactStore,
        askQuestion: this.askQuestionHandler,
        switchMode: this.switchModeHandler,
        // 本会话已触发的 skill 目录 → 只读工具的额外允许根
        extraAllowedRoots: [...this.skillRoots],
        ...(this.assertExecutionCurrent
          ? { assertExecutionCurrent: this.assertExecutionCurrent }
          : {})
      })

    const loopConfig: LoopConfig = {
      maxToolRounds: this.maxToolRounds,
      toolExecution: this.config.toolExecution ?? 'parallel',
      maxParallelToolCalls: this.config.maxParallelToolCalls ?? 4,
      supportsVision: this.config.supportsVision ?? true,
      shouldStopAfterTurn: (args) => this.stopPolicy.shouldStopAfterTurn(args),
      getModeTransitionInstruction: () => this.getCurrentModeInstruction(),
      enforceInlineBudget: (messages) => this.contextBudgetManager.enforceInline(messages),
      runOverflowCompaction: (mode) =>
        this.compactionService.runOverflowCompaction(mode, this.abortController?.signal)
    }

    // 模型终态错误只在此记录；错误事件与全部收尾由 finalizeTurn 统一执行，
    // 保证 checkpoint 在错误路径同样被关闭、终态事件恰好一个。
    let terminalError: string | null = null

    const endResult: LoopEndResult = await runAgentLoop({
      messageId,
      userText,
      context: this.ctx,
      config: loopConfig,
      streamProcessor: this.getStreamProcessor(),
      hookManager: this.hookManager,
      emit: (event) => this.eventBus.emit(event),
      emitContextBreakdown: (mid, promptTokens) => this.emitContextBreakdown(mid, promptTokens),
      signal: () => this.cancelled,
      abortSignal: () => this.abortController?.signal,
      executeBatch,
      runCompactionIfThreshold: async () => {
        await this.compactionService.runThresholdCompaction(this.abortController?.signal)
      },
      updateTokenEstimate: () => this.compactionService.updateTokenEstimate(),
      sleep: (ms: number) => this.sleep(ms),
      onTerminalError: (error) => {
        terminalError = error
      }
    })

    if (endResult.ended === 'error') {
      // onError hook 已在 StreamProcessor / runAgentLoop 内触发，此处不再重复
      return { status: 'failed', error: new Error(terminalError ?? '模型调用失败') }
    }

    // cancelled 标志由 runAgentLoop 在 StreamProcessor cancelled /
    // executeBatch abort 时通过 endResult.cancelled=true 透传。
    if (endResult.cancelled) {
      this.cancelled = true
    }

    return this.settledTurnOutcome()
  }

  /** 正常返回路径的轮次结果：取消标志已置位时收敛为 cancelled */
  private settledTurnOutcome(): AgentTurnOutcome {
    return this.cancelled ? { status: 'cancelled' } : { status: 'completed' }
  }

  /** best-effort 触发 onError hook：hook 自身异常只记录，不得阻断终态收尾或覆盖原始错误 */
  private async notifyErrorHook(messageId: string, error: string): Promise<void> {
    try {
      await this.hookManager.trigger({ event: 'onError', messageId, error })
    } catch (hookErr) {
      console.error('[AgentLoop] onError hook 异常（已忽略，保留原始错误）:', hookErr)
    }
  }

  /**
   * 校验已解析 route 是否具备执行能力（委托 TurnDispatcher 的能力断言）。
   * 不产生副作用，可在轮次副作用前安全调用。
   */
  private assertRouteExecutable(route: AgentTurnRoute): void {
    this.turnDispatcher.assertRouteExecutable(route)
  }

  /**
   * 唯一的轮次终态收尾。所有开始过的轮次（成功 / 取消 / 失败）都必须经过这里：
   * - 只关闭确已开始的 checkpoint 事务；endMessage 失败不得阻断其余清理——
   *   成功轮次遇到关闭失败按 failed 收尾（forward 快照缺失会破坏分支重放），
   *   已失败轮次只记录次生错误，不覆盖原始错误；
   * - 清空本轮引用（currentMessageId / abortController）并收敛 state；
   * - 发出恰好一个持久化终态事件：failed → error，completed/cancelled → message_end，
   *   error 之后不得再补发 message_end；
   * - 只在 completed 时启动空闲压缩计时器：cancel 通常意味着模型走偏，
   *   failed 的上下文已损坏，两者后台压缩都只会烧 token 或在用户不知情时改写历史。
   */
  private finalizeTurn(
    messageId: string,
    outcome: AgentTurnOutcome,
    checkpointBegun: boolean
  ): AgentTurnOutcome {
    if (checkpointBegun) {
      try {
        this.checkpointManager?.endMessage()
      } catch (err) {
        const endError = err instanceof Error ? err : new Error(String(err))
        if (outcome.status === 'failed') {
          console.error('[AgentLoop] checkpoint 收尾次生错误（保留原始错误）:', endError)
        } else {
          outcome = { status: 'failed', error: endError }
        }
      }
    }

    // onCancel 由 RunCoordinator.commitTerminal 统一触发（exactly-once）；
    // 此处不再重复 hook，避免 cancel() + 终态收尾双触发。
    this.currentMessageId = null
    this.abortController = null

    if (outcome.status === 'failed') {
      this.state = 'error'
    } else if (this.state === 'running') {
      this.state = 'idle'
    }

    if (outcome.status === 'failed') {
      this.eventBus.emit({ type: 'error', messageId, error: outcome.error.message })
    } else {
      this.eventBus.emit({
        type: 'message_end',
        messageId,
        ...(outcome.status === 'cancelled' ? { interrupted: true } : {})
      })
    }

    if (outcome.status === 'completed') {
      this.idleTimer ??= new IdleCompressionTimer(this)
      this.idleTimer.start()
    } else {
      this.idleTimer?.cancel()
      if (outcome.status === 'failed') {
        this.idleTimer = null
      }
    }

    return outcome
  }

  /** 对工具输出应用截断，超限时用三明治模式拼装提示 */
  private applyTruncation(output: string, maxSize: number): string {
    const pipeline = createTruncationPipeline({ maxByteSize: maxSize })
    const result = pipeline.apply(output)

    if (!result.truncated || !result.meta) {
      return output
    }

    const { shown, total, limit, truncatedAt } = result.meta
    const topHint = `[系统提示] 以下为截断结果（显示 ${shown}/${total ?? '?'}，触发 ${truncatedAt} 上限 ${limit}）\n`
    const bottomAction = this.buildBottomActions(truncatedAt, shown, total, limit)

    return topHint + result.output + '\n' + bottomAction
  }

  /** 按截断层生成可执行的底部建议 */
  private buildBottomActions(
    stage: TruncationStage,
    shown: number,
    total: number | undefined,
    limit: number
  ): string {
    switch (stage) {
      case 'match_count':
        return `[系统提示] 结果已截断：显示 ${shown}/${total ?? '?'} 条（匹配数上限 ${limit}）。请执行以下之一：\n1. 添加 glob: "*.ts" 过滤文件类型\n2. 使用 output_mode: "files_with_matches" 先确认涉及哪些文件\n3. 缩小 path 到具体子目录\n4. 使用 head_limit + offset 分批获取下一批`

      case 'byte_size':
        return `[系统提示] 结果已截断：输出 ${shown}KB/${total ?? '?'}KB（字节上限 ${limit}KB）。请执行以下之一：\n1. 使用 output_mode: "files_with_matches" 仅获取文件路径\n2. 缩小 path 到具体子目录\n3. 添加 glob 过滤减少匹配文件数`

      case 'line_length':
        return `[系统提示] 部分行已截断：行长度超 ${limit} 字符上限，超出部分以 ...[截断] 标记。\n对该文件使用 read 工具获取完整内容。`
    }
  }

  /** 异步 sleep（恢复重试用） */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /** 取消当前执行 */
  cancel(): void {
    if (this.state === 'running') {
      this.cancelled = true
      this.state = 'cancelled'
      this.abortController?.abort()
      // onCancel 改由 RunCoordinator 在 commitTerminal 时 exactly-once 触发；
      // 此处不再直接 hook，避免与 finishMessageRound 双触发。
      // 中止所有等待中的权限请求（PermissionAbortedError 语义，不生成权限拒绝 tool_result）
      this.permissionCoordinator.abortPending()
    }
  }

  /**
   * 彻底释放 AgentLoop 持有的所有资源。
   *
   * 与 cancel() 的区别：cancel() 只在 state==='running' 时生效，
   * 而 dispose() 在 idle 状态下也要清理 idleTimer（否则 266 秒后会触发后台压缩烧 token，
   * 且 subLoop 对象图无法被 GC）。
   *
   * 调用场景：
   * - 子 agent（taskTool / runSkillFork / workflow）执行完后释放
   * - 主 turn 的 loop 在 idle 托管期结束后释放（下一 turn 装配 / 会话取消 / 会话删除）
   */
  dispose(): void {
    // 先置 disposed，阻断已排队的 idle timer 到期后进入摘要请求
    this.disposed = true

    // 即使 state 不是 running 也要清理 idleTimer：sendMessage 完成后 state===idle，
    // cancel() 此时是空操作，idleTimer 仍在等待触发后台压缩
    this.idleTimer?.cancel()
    this.idleTimer = null

    // 兜底清理 pending permissions（cancel 在 idle 时跳过这一步）
    this.permissionCoordinator.abortPending()

    // 如果还在 running，也走 cancel 流程触发 onCancel hook
    if (this.state === 'running') {
      this.cancel()
    }
  }

  /**
   * 供 IdleCompressionTimer 到期时做资格预筛。
   * profile 入口已预留（T3-2 按 idlePolicy 差异化）；本轮预筛只做中性判断。
   */
  getIdleCompactionScheduleState(): IdleCompactionScheduleState {
    const provider = this.modelPool.getActiveProvider()
    const profile = resolveCacheProfile(provider.baseUrl, provider.modelId, {
      cacheProfile: provider.cacheProfile,
      cacheStrategy: provider.cacheStrategy
    })
    return {
      context: this.context,
      contextWindow: this.config.contextWindow ?? 200_000,
      estimatedTokens: this.lastEstimatedTokens > 0 ? this.lastEstimatedTokens : undefined,
      idleCompactionInProgress: this.idleCompactionInProgress,
      disposed: this.disposed,
      // T3-2 按 idlePolicy 差异化调度；本轮 shouldScheduleIdleCompaction 不读此字段
      profile
    }
  }

  /**
   * 批量权限检查入口（稳定代理：规则判定与交互等待由 PermissionCoordinator 持有）
   */
  public async checkBatchPermission(
    items: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>,
    messageId: string
  ): Promise<Map<string, { allowed: boolean; reason: string; aborted?: boolean }>> {
    return this.permissionCoordinator.checkBatchPermission(items, messageId)
  }

  /** 当前 loop 是否拥有指定权限请求的 resolver。 */
  hasPendingPermission(requestId: string): boolean {
    return this.permissionCoordinator.hasPendingPermission(requestId)
  }

  /**
   * 回应权限请求（由 IPC handler 调用）
   * @param requestId 权限请求 ID
   * @param granted 用户是否允许
   */
  respondPermission(requestId: string, granted: boolean): void {
    this.permissionCoordinator.respondPermission(requestId, granted)
  }

  /** 清空对话上下文 */
  reset(): void {
    this.context = this.frozenSystemPrompt
      ? [{ role: 'system', content: this.frozenSystemPrompt }]
      : []
    this.state = 'idle'
    this.cancelled = false
    this.abortController = null
    this.idleTimer?.cancel()
  }

  /**
   * 获取本轮 user 消息应拼接的 session context 前缀文本。
   *
   * 扫描当前 context，判断是否仍存在"与当前工作区/模型/日期完全一致"的 session context 前缀。
   * 只要有一条 user 消息仍保留这段前缀，就认为锚点仍在，无须重注。这统一处理所有生命周期场景：
   * - 同日首轮：context 中无锚点 → 注入
   * - 同日后续轮：锚点仍在 context 中 → 跳过
   * - 跨天 / reset() 后 / 压缩后 / setWorkingDir 后：旧锚点失效 → 重注
   *
   * @returns session context 文本，或 null（锚点仍在，跳过）
   */
  private getSessionContextPrefix(): string | null {
    const workingDir = this.workingDir ?? process.cwd()
    const model = this.modelPool.getActiveProvider().modelId
    const sessionContext = buildSessionContext({
      workingDir,
      model,
      date: this.getSessionContextDate()
    })

    // 扫描 context：是否仍保留与"当前工作区 / 当前模型 / 今天"完全一致的锚点
    if (this.contextHasValidAnchor(sessionContext)) return null

    return sessionContext
  }

  /**
   * 检查当前 context 中是否存在"仍然有效的" session context 锚点。
   *
   * 判据：
   * - 仅扫描 user 消息，避免 assistant/tool 回显文本误命中
   * - 仅看消息开头的 session context 前缀段，避免正文里碰巧出现同样字符串
   * - 与本轮应生成的完整前缀做逐字节相等比较，避免 workingDir 前缀子串误判
   */
  private contextHasValidAnchor(expectedPrefix: string): boolean {
    return this.context.some(m => {
      if (m.role !== 'user') return false
      return this.extractSessionContextPrefix(m.content) === expectedPrefix
    })
  }

  /**
   * 从 user 消息里提取 session context 前缀。
   *
   * string 路径用 `\n\n` 分隔前缀与正文；多模态路径则把前缀放在首个 text block。
   * 单独抽出来可避免 `extractTextFromContent()` 把 text block 全部拼接后，
   * 把图片消息误判成"整条文本都等于前缀"。
   */
  private extractSessionContextPrefix(content: string | ContentBlock[]): string | null {
    if (typeof content === 'string') {
      if (!content.startsWith('[Session context:')) return null
      return content.split('\n\n')[0] ?? content
    }

    const firstBlock = content[0]
    if (!firstBlock || firstBlock.type !== 'text') return null
    return firstBlock.text.startsWith('[Session context:') ? firstBlock.text : null
  }

  /**
   * 提供 session context 使用的"当前时间"。
   * 抽成独立方法便于测试覆盖（例如跨天重注场景可覆写固定日期）。
   */
  protected getSessionContextDate(date: Date = new Date()): Date {
    return date
  }

  /**
   * @internal 供 IdleCompressionTimer 调用。
   *
   * Timer 的 signal 直接控制摘要请求和写回 fence，不借用 active turn controller。
   * 新消息取消 idle 时只会终止旧摘要，不会修改新 active turn 的取消状态。
   */
  async runIdleCompaction(abortSignal: AbortSignal): Promise<void> {
    this.idleCompactionInProgress = true
    try {
      await this.compactionService.runIdleCompaction(abortSignal)
    } finally {
      this.idleCompactionInProgress = false
    }
  }
}
