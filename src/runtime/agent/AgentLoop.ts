/**
 * AgentLoop — 核心消息-模型-工具循环的门面类。
 * 接收用户消息，组织上下文，调用模型，处理工具调用，通过 EventBus 向外发射流式事件。
 * 纯循环驱动已下沉到 runAgentLoop，本类负责装配、收尾和上下文压缩。
 */
import type { ModelClient } from '../model/ModelClient'
import { ModelClientPool } from '../model/ModelClientPool'
import type { ChatMessage, ChatToolCall, ContentBlock, ToolDefinition } from '../model/types'
import { extractTextFromContent } from '../model/types'
import type { AgentState, AgentLoopConfig } from './types'
import { ToolRegistry } from '../tools/ToolRegistry'
import type { CheckpointManager } from '../checkpoints/CheckpointManager'
import type { PermissionManager } from '../permissions/PermissionManager'
import type { SessionStore } from '../sessions/SessionStore'
import type { Mode } from '../../shared/session/types'
import type { TruncationStage } from '../tools/grep-types'
import { createTruncationPipeline } from '../tools/TruncationPipeline'
import { EventBus } from './EventBus'
import { splitForCompaction, buildCompactionRequestTail, rebuildWithCompression, stripReasoningContent, MIN_RECENT_MESSAGES } from './compaction/compaction'
import { createProductionContextBudgetManager, compactAtBoundary, ContextBudgetExceededError, type ContextBudgetManager } from './ContextBudgetManager'
import { CacheDiagnostics } from '../model/cacheDiagnostics'
import { randomUUID } from 'crypto'
import { estimateContextTokens } from './tokenEstimator'
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
import type { SkillRegistry } from '../skills/SkillRegistry'
import { runSkillFork, type RunSkillForkDeps } from '../skills/runSkillFork'
import { createReadState, type ReadState } from '../tools/editTool'
import type { ArtifactStore } from '../artifacts/ArtifactStore'
import type { AskQuestionItem, AskQuestionAnswer } from '../../shared/askQuestion/types'
import type { FileEffectRecorder } from '../tools/types'

import { invokeSkill } from '../skills/invokeSkill'
import { getModeInstruction } from './promptBuilder/modeInstruction'
import { createAgentContext, getEffectiveToolDefinitions, type AgentContext } from './core/AgentContext'
import { StreamProcessor } from './stream/StreamProcessor'
import { runAgentLoop, type LoopEndResult } from './core/runAgentLoop'
import { createCompactionExtension } from './extensions/compactionExtension'
import { createPermissionExtension } from './extensions/permissionExtension'
import { createToolPostProcessExtension } from './extensions/toolPostProcessExtension'
import { StopPolicyExtension } from './extensions/stopPolicyExtension'
import type { AgentLoopConfig as LoopConfig } from './core/loopTypes'

/** 写入类工具名称集合，plan 模式下会被拒绝 */
const WRITE_TOOLS: Record<string, true> = {
  edit: true,
  write: true,
  bash: true
}

/**
 * 表示权限请求被 cancel 中断的 sentinel 错误。
 * 用于 checkPermission 区分"用户主动拒绝"（产生"权限拒绝"工具结果）
 * 和"流程被取消"（不产生任何 tool_result，不污染 context 与持久化）。
 */
class PermissionAbortedError extends Error {
  constructor() {
    super('permission request aborted by cancel')
    this.name = 'PermissionAbortedError'
  }
}

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

  /** 权限决策引擎（可选） */
  private permissionManager: PermissionManager | null = null
  private toolAuthorizationPolicy:
    | ((toolName: string, args: Record<string, unknown>) => { allowed: boolean; reason: string })
    | null = null

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

  /** 等待用户确认的权限请求（requestId → { resolve, reject } 回调） */
  private pendingPermissions: Map<
    string,
    { resolve: (granted: boolean) => void; reject: (err: Error) => void }
  > = new Map()

  /** 最大工具调用轮数（可动态调整） */
  private maxToolRounds: number

  /** 生产路径上下文硬预算（按 contextWindow 配置） */
  private contextBudgetManager: ContextBudgetManager

  /** 缓存诊断跟踪器：检测 system prompt / 工具定义变化导致的缓存失效 */
  private cacheDiagnostics = new CacheDiagnostics()

  /** 截断管道：用于工具输出超限时进行结构化截断 */
  private truncationPipeline = createTruncationPipeline()

  /** 是否正在执行溢出压缩（用于守卫正常压缩逻辑） */
  private compressingForOverflow = false
  /** 缓存上次估算的 token 数，用于判断守卫 */
  private get lastEstimatedTokens(): number {
    return this.ctx.lastEstimatedTokens
  }
  private set lastEstimatedTokens(value: number) {
    this.ctx.lastEstimatedTokens = value
  }
  /** 距上次压缩后的 user 消息回合数（软触发冷却） */
  private get userTurnsSinceCompaction(): number {
    return this.ctx.userTurnsSinceCompaction
  }
  private set userTurnsSinceCompaction(value: number) {
    this.ctx.userTurnsSinceCompaction = value
  }
  /** 压缩层级计数 */
  private get compactionLevel(): number {
    return this.ctx.compactionLevel
  }
  private set compactionLevel(value: number) {
    this.ctx.compactionLevel = value
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
        runOverflowCompaction: (mode) => this.runOverflowCompaction(mode),
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

  /** 统一 skill 调度：slash inject / fork / workflow */
  private skillRegistry: SkillRegistry | null = null
  private skillForkDeps: RunSkillForkDeps | null = null
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
   * 编排脚本 runner（由 agentHandler 注入）。
   * 返回摘要文本推给 UI；失败抛错由 sendMessage 捕获。
   * opts.abortSignal 是本轮 AgentLoop 的取消信号——runner 必须把它接到
   * runWorkflow，否则停止按钮无法终止编排 run（会全局卡死 send-message）。
   */
  private workflowRunner:
    | ((
        scriptName: string,
        args: string,
        opts?: { abortSignal?: AbortSignal }
      ) => Promise<{ summary: string }>)
    | null = null
  private xforgeRunner:
    | ((
        request: string,
        opts: { abortSignal?: AbortSignal; messageId: string; explicitFullDev: boolean }
      ) => Promise<{ summary: string }>)
    | null = null
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
    this.config = {
      systemPrompt: config?.systemPrompt ?? '你是 Nova 的编程助手。',
      systemPromptLayers: config?.systemPromptLayers,
      maxToolRounds: config?.maxToolRounds ?? 20,
      contextWindow: config?.contextWindow,
      supportsVision: config?.supportsVision ?? true,
      toolExecution: config?.toolExecution ?? 'parallel',
      maxParallelToolCalls: Math.max(1, config?.maxParallelToolCalls ?? 4),
      onCompaction: config?.onCompaction,
      useUnifiedSkillDispatch: config?.useUnifiedSkillDispatch !== false,
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
    // this.context 是 AgentLoop 运行时的扁平线性数组(不分叉)，这里补齐一条
    // 首尾相连的 id/parentId 链，并把 currentLeafId 指向最后一条消息。
    // 注意：getSessionActiveMessages 把 currentLeafId=null 解释为"会话已回退到
    // 起点，激活路径为空"（真实会话树语义），若直接传 null 会导致 computeActivePath
    // 恒返回空数组——messages 分项估算恒为 0，表现为上下文用量面板卡死不动。
    const sessionMessages = this.context
      .filter(m => m.role !== 'system')
      .map((m, i) => this.toSessionMessageForBreakdown(m, i))
    const leafId = sessionMessages.length > 0 ? sessionMessages[sessionMessages.length - 1]!.id : null

    const result = calculateContextBreakdown({
      session: {
        id: this.sessionId ?? '',
        workspaceRoot: this.workingDir ?? '',
        mode: this.mode ?? 'default',
        messages: sessionMessages,
        currentLeafId: leafId,
        frozenSystemPrompt: this.frozenSystemPrompt,
        schemaVersion: 2,
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
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

  /** 把运行时的 ChatMessage 转成 SessionMessage 口径(仅用于 token 估算) */
  private toSessionMessageForBreakdown(
    m: ChatMessage,
    index: number
  ): import('../sessions/types').SessionMessage {
    return {
      id: `ctx-${index}`,
      parentId: index === 0 ? null : `ctx-${index - 1}`,
      role: m.role,
      content: typeof m.content === 'string' ? m.content : extractTextFromContent(m.content),
      toolCalls: m.toolCalls?.map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments
      })),
      toolCallId: m.toolCallId,
      timestamp: Date.now()
    }
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
    const systemPrompt = extractTextFromContent(
      this.context.find(m => m.role === 'system')?.content ?? ''
    )
    this.context = rebuildWithCompression(systemPrompt, summary, recentMessages)
    this.compactionLevel = compactionLevel
    this.userTurnsSinceCompaction = 0
    this.lastEstimatedTokens = estimateContextTokens(this.context)
    this.cacheDiagnostics.bumpEpoch('compaction')
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
    this.permissionManager = manager
  }

  /** 注入写工具使用的持久化副作用协议。 */
  setFileEffectRecorder(recorder: FileEffectRecorder | null): void {
    this.fileEffectRecorder = recorder
  }

  /**
   * 叠加在基础 PermissionManager 之前的运行时权限策略。
   * 用于阶段工作流等更窄的能力边界；拒绝项不会再弹基础权限确认。
   */
  setToolAuthorizationPolicy(
    policy: ((toolName: string, args: Record<string, unknown>) => { allowed: boolean; reason: string }) | null
  ): void {
    this.toolAuthorizationPolicy = policy
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

  /** 注入技能注册表（统一 slash 调度） */
  setSkillRegistry(registry: SkillRegistry | null): void {
    this.skillRegistry = registry
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

  /** 注入 fork skill 执行依赖 */
  setSkillForkDeps(deps: RunSkillForkDeps | null): void {
    this.skillForkDeps = deps
  }

  /** 注入编排脚本 runner（/br-full-dev 等 workflow skill） */
  setWorkflowRunner(
    runner:
      | ((
          scriptName: string,
          args: string,
          opts?: { abortSignal?: AbortSignal }
        ) => Promise<{ summary: string }>)
      | null
  ): void {
    this.workflowRunner = runner
  }

  /** 注入原生 XForge Stage Pipeline；自然语言与 /br-full-dev 共用此入口。 */
  setXForgeRunner(
    runner:
      | ((
          request: string,
          opts: { abortSignal?: AbortSignal; messageId: string; explicitFullDev: boolean }
        ) => Promise<{ summary: string }>)
      | null
  ): void {
    this.xforgeRunner = runner
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
   * 发送用户消息并启动循环
   * 发射 message_start → (流式 text_delta / tool_call / tool_result) → message_end
   */
  async sendMessage(content: string | ContentBlock[]): Promise<void> {
    if (this.state === 'running') {
      this.eventBus.emit({ type: 'error', messageId: '', error: '当前正在执行中，请先取消' })
      return
    }

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

    // 开启 checkpoint 事务边界（generation 失效时拒绝，避免假终止后仍建快照）
    if (this.assertExecutionCurrent && !this.assertExecutionCurrent()) {
      throw new Error('checkpoint 被拒绝：执行 generation 已失效')
    }
    this.checkpointManager?.beginMessage(messageId)

    this.eventBus.emit({ type: 'message_start', messageId })

    const modeInstruction = this.modeInstructionProvider?.() ?? getModeInstruction(this.mode)
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

    // 统一 skill 调度：slash inject / fork / system_notice（纯文本且开关开启时）
    const useSkillDispatch =
      typeof content === 'string' &&
      this.skillRegistry &&
      this.config.useUnifiedSkillDispatch !== false

    if (useSkillDispatch) {
      let dispatch = invokeSkill({
        input: content,
        registry: this.skillRegistry!,
        profile: this.mode,
        templateContext: { workspacePath: this.workingDir ?? undefined }
      })

      const explicitFullDev =
        dispatch.kind === 'workflow' && dispatch.scriptName === 'br-full-dev'
      if (
        this.mode === 'compose' &&
        this.xforgeRunner &&
        (dispatch.kind === 'passthrough' || explicitFullDev)
      ) {
        try {
          const result = await this.xforgeRunner(
            explicitFullDev && dispatch.kind === 'workflow' ? dispatch.args : content as string,
            {
              abortSignal: this.abortController?.signal,
              messageId,
              explicitFullDev
            }
          )
          this.context.push({ role: 'assistant', content: result.summary })
          this.eventBus.emit({ type: 'text_delta', messageId, delta: result.summary })
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          await this.hookManager.trigger({ event: 'onError', messageId, error: errMsg })
          this.eventBus.emit({ type: 'error', messageId, error: errMsg })
          this.state = 'error'
          this.checkpointManager?.endMessage()
          this.eventBus.emit({ type: 'message_end', messageId })
          this.idleTimer?.cancel()
          this.idleTimer = null
          return
        }
        await this.finishMessageRound(messageId)
        return
      }

      if (dispatch.kind === 'workflow' && this.workflowRunner) {
        // 编排入口：自动切入 compose，跑脚本，摘要推 UI
        if (this.mode !== 'compose') {
          this.setMode('compose')
        }
        try {
          // 透传本轮取消信号：停止按钮 → cancel() → abortController.abort()
          // → runWorkflow 内部 cancelWorkflow，编排 run 才能真正终止。
          const wfResult = await this.workflowRunner(dispatch.scriptName, dispatch.args, {
            abortSignal: this.abortController?.signal
          })
          this.context.push({ role: 'assistant', content: wfResult.summary })
          this.eventBus.emit({ type: 'text_delta', messageId, delta: wfResult.summary })
        } catch (err) {
          const errMsg = (err as Error).message
          await this.hookManager.trigger({ event: 'onError', messageId, error: errMsg })
          this.eventBus.emit({ type: 'error', messageId, error: errMsg })
          this.state = 'error'
          this.checkpointManager?.endMessage()
          this.eventBus.emit({ type: 'message_end', messageId })
          this.idleTimer?.cancel()
          this.idleTimer = null
          return
        }
        await this.finishMessageRound(messageId)
        return
      }

      if (dispatch.kind === 'fork' && this.skillForkDeps) {
        try {
          const forkResult = await runSkillFork(this.skillForkDeps, {
            skill: dispatch.skill,
            args: dispatch.args,
            ctx: {
              workingDir: this.workingDir ?? process.cwd(),
              readState: this.readState,
              shellPath: this.shellPath,
              binDirs: this.binDirs
            },
            templateContext: { workspacePath: this.workingDir ?? undefined }
          })
          this.context.push({ role: 'assistant', content: forkResult.summary })
          this.eventBus.emit({ type: 'text_delta', messageId, delta: forkResult.summary })
        } catch (err) {
          const errMsg = (err as Error).message
          await this.hookManager.trigger({ event: 'onError', messageId, error: errMsg })
          this.eventBus.emit({ type: 'error', messageId, error: errMsg })
          this.state = 'error'
          this.checkpointManager?.endMessage()
          this.eventBus.emit({ type: 'message_end', messageId })
          // error 状态取消 idleTimer，避免后台压缩污染损坏 context
          this.idleTimer?.cancel()
          this.idleTimer = null
          return
        }
        await this.finishMessageRound(messageId)
        return
      }

      if (dispatch.kind === 'inject') {
        // slash / 自动路由 inject：把该 skill 目录登记为额外只读根
        if (dispatch.skillDirectory) {
          this.addSkillRoot(dispatch.skillDirectory)
        }
        this.context.push({ role: 'assistant', content: dispatch.assistantContent })
        this.context.push({
          role: 'user',
          content: withPrefix(`${dispatch.userContent}\n\n${modeInstruction}`)
        })
        userText = dispatch.userContent
      } else if (dispatch.kind === 'system_notice') {
        this.context.push({
          role: 'user',
          content: withPrefix(`${dispatch.text}\n\n${modeInstruction}`)
        })
        userText = dispatch.text
      } else if (dispatch.kind === 'passthrough') {
        this.context.push({
          role: 'user',
          content: withPrefix(`${content}\n\n${modeInstruction}`)
        })
      }
    } else {
      // 默认路径：用户消息 + 模式指令
      let userContent: string | ContentBlock[]
      if (typeof content === 'string') {
        userContent = withPrefix(`${content}\n\n${modeInstruction}`)
      } else {
        // ContentBlock[]（含图片）：sessionPrefix 作为首个 text block 插入最前面
        const blocks = sessionPrefix
          ? [{ type: 'text' as const, text: sessionPrefix }, ...content, { type: 'text' as const, text: modeInstruction }]
          : [...content, { type: 'text' as const, text: modeInstruction }]
        userContent = blocks
      }
      this.context.push({ role: 'user', content: userContent })
    }

    // 每轮 user 消息递增压缩冷却计数
    this.userTurnsSinceCompaction++

    // 此处只估算，不抛硬预算：阈值压缩在 runAgentLoop 内先于模型调用执行。
    // 硬上限在压缩之后、发模型之前套用（见 runAgentLoop），避免大历史无法进入压缩。
    this.lastEstimatedTokens = estimateContextTokens(this.context)

    // 主循环下沉到 runAgentLoop：hooks → compaction → StreamProcessor → assistant 续接 → executeBatch → shouldStopAfterTurn。
    // Facade 负责：装配 config（注入 extension）、构建 executeBatch（注入权限/截断 extension）、
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
        checkPermission: createPermissionExtension(this),
        checkBatchPermission: (items, msgId) => this.checkBatchPermission(items, msgId),
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
      onCompaction: (context, meta) => this.config.onCompaction?.(context, meta),
      enforceInlineBudget: (messages) => this.contextBudgetManager.enforceInline(messages),
      runOverflowCompaction: (mode) => this.runOverflowCompaction(mode)
    }

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
      runCompactionIfThreshold: createCompactionExtension({
        context: this.ctx,
        contextWindow: this.config.contextWindow ?? 200_000,
        isCompressingForOverflow: () => this.compressingForOverflow,
        runCompaction: () => this.runCompaction()
      }),
      isCompressingForOverflow: () => this.compressingForOverflow,
      sleep: (ms: number) => this.sleep(ms),
      onTerminalError: (error) => {
        // 终态错误：emit error + state=error + 取消 idleTimer，不经 finishMessageRound 直接 return。
        this.eventBus.emit({ type: 'error', messageId, error })
        this.state = 'error'
        this.idleTimer?.cancel()
        this.idleTimer = null
      }
    })

    if (endResult.ended === 'error') {
      // 终态错误：onTerminalError 已完成 emit/state/idleTimer 收尾，直接 return。
      // 错误意味着本轮已损坏，后台压缩只会把损坏内容发给模型烧 token。
      // 用户回来时应主动 sendMessage 触发新一轮，而不是后台悄悄压缩。
      return
    }

    // ended === 'normal'：cancelled 标志由 runAgentLoop 在 StreamProcessor cancelled /
    // executeBatch abort 时通过 endResult.cancelled=true 透传。
    if (endResult.cancelled) {
      this.cancelled = true
    }

    await this.finishMessageRound(messageId)
  }

  /** 结束一轮消息：checkpoint 收尾、message_end、空闲压缩计时 */
  private async finishMessageRound(messageId: string): Promise<void> {
    if (this.state === 'running') {
      this.state = 'idle'
    }

    this.checkpointManager?.endMessage()

    // onCancel 由 RunCoordinator.commitTerminal 统一触发（exactly-once）；
    // 此处不再重复 hook，避免 cancel() + finishMessageRound 双触发。
    this.currentMessageId = null

    this.eventBus.emit({
      type: 'message_end',
      messageId,
      ...(this.cancelled ? { interrupted: true } : {})
    })

    // cancel 状态下不启动 idleTimer。
    // 用户主动取消通常意味着模型走偏，启动后台压缩既浪费 token 又可能在用户
    // 不知情时改写 context（再次进入会话发现历史已被压缩）。让用户主动发起下一条消息。
    if (!this.cancelled) {
      this.idleTimer ??= new IdleCompressionTimer(this)
      this.idleTimer.start()
    }
  }

  /**
   * 压缩成功后的统一簿记：用摘要重建上下文，并更新压缩层级 / 冷却计数 / token 估算 / 缓存基线。
   *
   * 主动阈值压缩（runCompaction）与反应式溢出压缩（runOverflowCompaction）共用此方法，
   * 消除两处逐字节重复的「重建 + 簿记」逻辑。
   *
   * why 不在此触发 onCompaction：runCompaction 在 onCompaction 回调前还有一次
   * abortSignal 检查（idle 压缩期间用户可能已发新消息），而溢出压缩没有。为保持两条路径
   * 的 abort 语义与重构前逐字节一致，onCompaction 由各调用方在簿记后自行触发。
   *
   * @param systemPrompt 冻结的 system prompt 文本
   * @param summary 已 trim 的摘要文本
   * @param recentMessages 压缩后保留的最近消息
   * @param pulledBackMessages 溢出压缩时被弹出、需追加回上下文尾部的消息（阈值压缩不传）
   */
  private applyCompactionResult(
    systemPrompt: string,
    summary: string,
    recentMessages: ChatMessage[],
    pulledBackMessages?: ChatMessage[]
  ): void {
    const rebuilt = rebuildWithCompression(systemPrompt, summary, recentMessages, pulledBackMessages)
    // 压缩重建后仅校验预算，不做改写（治理已在 compactAtBoundary 完成）
    const budget = this.contextBudgetManager.enforceInline(rebuilt)
    if (budget.status === 'requires_compaction') {
      throw new ContextBudgetExceededError(budget.estimatedTokens, budget.serializedBytes, true)
    }
    this.context = rebuilt
    this.compactionLevel++
    this.userTurnsSinceCompaction = 0
    this.lastEstimatedTokens = estimateContextTokens(this.context)
    this.cacheDiagnostics.bumpEpoch('compaction')
  }

  /**
   * 执行上下文压缩
   * 将旧消息发给模型生成摘要，然后用 [system, 摘要, 最近 N 条] 重建上下文。
   * 压缩调用本身复用现有缓存前缀（只追加压缩指令到尾部）。
   *
   * @param abortSignal 可选的 abort 信号：传入时会在替换 context 前检查，
   *   abort 则直接 return 不替换。这样压缩期间 sendMessage 推入的新消息能保留，
   *   避免回滚方案误删用户新消息。
   */
  private async runCompaction(
    abortSignal?: AbortSignal,
    trigger: 'threshold' | 'idle' = 'threshold'
  ): Promise<void> {
    const systemMsg = this.context.find(m => m.role === 'system')
    const systemPrompt = extractTextFromContent(systemMsg?.content ?? '')

    const { oldMessages, recentMessages } = splitForCompaction(this.context, MIN_RECENT_MESSAGES)
    if (oldMessages.length === 0) return

    // 边界治理：只治理旧段，recentMessages 绝不触碰
    const { messages: governedOld } = compactAtBoundary(oldMessages)

    // 摘要请求：system + 治理后旧段 + 尾部压缩指令（不改 this.context 前缀）
    const compactionContext: ChatMessage[] = [
      ...(systemMsg ? [systemMsg] : []),
      ...stripReasoningContent(governedOld),
      ...buildCompactionRequestTail(governedOld[governedOld.length - 1]?.role, recentMessages.length)
    ]

    let summary = ''
    try {
      const stream = this.modelPool.chat(compactionContext, undefined, {
        abortSignal: this.abortController?.signal,
        includeInternalMessages: true,
        expectedCacheMiss: true,
        ...(this.config.promptCacheKey ? { promptCacheKey: this.config.promptCacheKey } : {})
      })
      for await (const event of stream) {
        if (this.cancelled) return
        if (event.type === 'text_delta') {
          summary += event.delta
        }
        // 压缩请求不经 StreamProcessor；自行写入诊断并标 expectedMiss
        if (event.type === 'wire_snapshot') {
          this.cacheDiagnostics.recordWireSnapshot(event.snapshot, { expectedMiss: true })
        }
      }
    } catch {
      return
    }

    if (!summary.trim()) return

    // 关键：替换 context 前检查 abort，防止压缩期间用户 sendMessage 推入的新消息被覆盖。
    // runIdleCompaction 会传 abortSignal，主循环的 runCompaction 不传。
    if (abortSignal?.aborted) return

    // 重建上下文 + 压缩后簿记（层级 / 冷却 / token 估算 / 缓存基线），与溢出压缩共用。
    this.applyCompactionResult(systemPrompt, summary.trim(), recentMessages)

    // onCompaction 回调前再检查一次：abort 后不应触发持久化，避免与主循环状态竞争
    if (abortSignal?.aborted) return
    // 通知外部持久化压缩态（agentHandler 写入 context-snapshot.json）
    this.config.onCompaction?.(this.context, {
      summary: summary.trim(),
      compactionLevel: this.compactionLevel,
      trigger
    })
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
      // 拒绝所有等待中的权限请求（用 PermissionAbortedError 而非 resolve(false)，
      // 这样 checkPermission 不会把它当成"用户拒绝"生成权限拒绝 tool_result）
      for (const [id, entry] of this.pendingPermissions) {
        entry.reject(new PermissionAbortedError())
        this.pendingPermissions.delete(id)
      }
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
   * - taskTool / runSkillFork 的子 agent 执行完后释放
   * - agentHandler 创建新 AgentLoop 前 dispose 旧的
   */
  dispose(): void {
    // 先置 disposed，阻断已排队的 idle timer 到期后进入摘要请求
    this.disposed = true

    // 即使 state 不是 running 也要清理 idleTimer：sendMessage 完成后 state===idle，
    // cancel() 此时是空操作，idleTimer 仍在等待触发后台压缩
    this.idleTimer?.cancel()
    this.idleTimer = null

    // 兜底清理 pending permissions（cancel 在 idle 时跳过这一步）
    for (const [, entry] of this.pendingPermissions) {
      entry.reject(new PermissionAbortedError())
    }
    this.pendingPermissions.clear()

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
   * 批量权限检查入口
   */
  public async checkBatchPermission(
    items: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>,
    messageId: string
  ): Promise<Map<string, { allowed: boolean; reason: string; aborted?: boolean }>> {
    const results = new Map<string, { allowed: boolean; reason: string; aborted?: boolean }>()

    if (items.length === 0) {
      return results
    }

    const remainingItems = items.filter(item => {
      const decision = this.toolAuthorizationPolicy?.(item.toolName, item.args)
      if (!decision || decision.allowed) return true
      results.set(item.toolCallId, decision)
      return false
    })

    if (remainingItems.length === 0) return results

    // 没有 PermissionManager 时，全部放行
    if (!this.permissionManager) {
      for (const item of remainingItems) {
        if (this.mode === 'plan' && WRITE_TOOLS[item.toolName]) {
          results.set(item.toolCallId, {
            allowed: false,
            reason: `当前为 plan 模式，"${item.toolName}" 工具不可用。请切换到 default 或 auto 模式后再执行写入操作。`
          })
        } else {
          results.set(item.toolCallId, { allowed: true, reason: '' })
        }
      }
      return results
    }

    // 逐个匹配本地规则 (持久化与模式规则)
    const askItems: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown>; riskLevel: 'low' | 'medium' | 'high'; reason: string }> = []
    
    for (const item of remainingItems) {
      const result = this.permissionManager.check({ toolName: item.toolName, args: item.args }, this.mode)
      if (result.decision === 'allow') {
        results.set(item.toolCallId, { allowed: true, reason: '' })
      } else if (result.decision === 'deny') {
        results.set(item.toolCallId, { allowed: false, reason: result.reason })
      } else {
        // decision === 'ask'
        askItems.push({
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          args: item.args,
          riskLevel: result.riskLevel,
          reason: result.reason
        })
      }
    }

    // 如果没有需要询问用户的项，直接返回
    if (askItems.length === 0) {
      return results
    }

    // 对需要询问的项，合并成一个批量 permission_request 弹卡片
    const requestId = randomUUID()
    const permissionResponse = this.waitForPermissionResponse(requestId)

    // 收集所有需要 ask 的命令文本
    const commands: string[] = []
    let maxRiskLevel: 'low' | 'medium' | 'high' = 'low'
    const riskLevelsWeight = { low: 1, medium: 2, high: 3 }
    const reasons: string[] = []

    for (const item of askItems) {
      const cmd = typeof item.args.command === 'string' ? item.args.command : JSON.stringify(item.args)
      commands.push(cmd)
      
      // 提取最高风险等级
      if (riskLevelsWeight[item.riskLevel] > riskLevelsWeight[maxRiskLevel]) {
        maxRiskLevel = item.riskLevel
      }
      reasons.push(item.reason)
    }

    // 合并说明文案
    const combinedReason = Array.from(new Set(reasons)).join('; ')

    this.eventBus.emit({
      type: 'permission_request',
      messageId,
      requestId,
      toolName: 'bash', // 既然合并了，以主类型 bash 描述
      args: askItems[0].args, // 兼容旧字段
      riskLevel: maxRiskLevel,
      reason: combinedReason,
      commands, // 传入批量命令列表
      // 内联放行：携带本批命令对应的 toolCallId 列表，
      // 渲染层据此把放行卡片直接挂到消息流中对应命令卡片上（锚点取末尾一张）。
      toolCallIds: askItems.map(item => item.toolCallId)
    })

    try {
      const granted = await permissionResponse
      for (const item of askItems) {
        if (!granted) {
          results.set(item.toolCallId, { allowed: false, reason: `用户拒绝了 "${item.toolName}" 工具的执行请求` })
        } else {
          results.set(item.toolCallId, { allowed: true, reason: '' })
        }
      }
      return results
    } catch (err) {
      if (err instanceof PermissionAbortedError) {
        for (const item of askItems) {
          results.set(item.toolCallId, { allowed: false, reason: '', aborted: true })
        }
        return results
      }
      throw err
    }
  }

  /**
   * 权限检查入口
   * 返回：
   * - { allowed: true }：可执行
   * - { allowed: false, reason }：用户主动拒绝或规则拒绝，需把"权限拒绝: {reason}"作为 tool_result 回传模型
   * - { aborted: true }：流程被 cancel 打断，调用方应跳过该工具的 tool_result 与 context 注入
   */
  private async checkPermission(
    toolName: string,
    args: Record<string, unknown>,
    messageId: string,
    toolCallId?: string
  ): Promise<{ allowed: boolean; reason: string; aborted?: boolean }> {
    const overlay = this.toolAuthorizationPolicy?.(toolName, args)
    if (overlay && !overlay.allowed) return overlay

    // 没有 PermissionManager 时退化为简单 plan 模式检查
    if (!this.permissionManager) {
      if (this.mode === 'plan' && WRITE_TOOLS[toolName]) {
        return {
          allowed: false,
          reason: `当前为 plan 模式，"${toolName}" 工具不可用。请切换到 default 或 auto 模式后再执行写入操作。`
        }
      }
      return { allowed: true, reason: '' }
    }

    const result = this.permissionManager.check({ toolName, args }, this.mode)

    if (result.decision === 'allow') {
      return { allowed: true, reason: '' }
    }

    if (result.decision === 'deny') {
      return { allowed: false, reason: result.reason }
    }

    // decision === 'ask'：发射 permission_request 事件，等待用户决策
    const requestId = randomUUID()
    const permissionResponse = this.waitForPermissionResponse(requestId)

    this.eventBus.emit({
      type: 'permission_request',
      messageId,
      requestId,
      toolName,
      args,
      riskLevel: result.riskLevel,
      reason: result.reason,
      // 内联放行：单工具场景把自身 toolCallId 作为唯一锚点传给渲染层
      ...(toolCallId ? { toolCallIds: [toolCallId] } : {})
    })

    try {
      const granted = await permissionResponse
      if (!granted) {
        return { allowed: false, reason: `用户拒绝了 "${toolName}" 工具的执行请求` }
      }
      return { allowed: true, reason: '' }
    } catch (err) {
      if (err instanceof PermissionAbortedError) {
        return { allowed: false, reason: '', aborted: true }
      }
      throw err
    }
  }

  /** 等待用户对权限请求的响应；cancel 时会以 PermissionAbortedError reject */
  private waitForPermissionResponse(requestId: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.pendingPermissions.set(requestId, { resolve, reject })
    })
  }

  /** 当前 loop 是否拥有指定权限请求的 resolver。 */
  hasPendingPermission(requestId: string): boolean {
    return this.pendingPermissions.has(requestId)
  }

  /**
   * 回应权限请求（由 IPC handler 调用）
   * @param requestId 权限请求 ID
   * @param granted 用户是否允许
   */
  respondPermission(requestId: string, granted: boolean): void {
    const entry = this.pendingPermissions.get(requestId)
    if (entry) {
      this.pendingPermissions.delete(requestId)
      entry.resolve(granted)
    }
  }

  /**
   * 上下文溢出紧急压缩
   * 参考 OpenClacky llm_caller.rb perform_context_overflow_compression (L426-517)
   *
   * @param mode 'standard' (pull_back=1, 保缓存) 或 'aggressive' (pull_back≈一半, 保生存)
   * @returns true 表示压缩成功，应重试原始请求；false 表示压缩失败或不可用
   */
  private async runOverflowCompaction(mode: 'standard' | 'aggressive'): Promise<boolean> {
    const pullBack = mode === 'aggressive'
      ? Math.max(4, Math.min(
          Math.floor(this.context.length / 2),
          this.context.length - 2,
          64))
      : 1

    this.compressingForOverflow = true
    const pulledBackMessages: ChatMessage[] = []

    const restorePulledBack = () => {
      pulledBackMessages.forEach(m => this.context.push(m))
    }

    try {
      // 1. 从 this.context 末尾弹出 pullBack 条消息
      for (let i = 0; i < pullBack && this.context.length > 2; i++) {
        const popped = this.context.pop()!
        if (popped.role !== 'system') {
          pulledBackMessages.unshift(popped)
        } else {
          this.context.push(popped)
          break
        }
      }

      // 2. 切分 + 边界治理
      const systemMsg = this.context.find(m => m.role === 'system')
      const systemPrompt = extractTextFromContent(systemMsg?.content ?? '')
      const { oldMessages, recentMessages } = splitForCompaction(this.context, MIN_RECENT_MESSAGES)

      if (oldMessages.length === 0) {
        restorePulledBack()
        return false
      }

      const { messages: governedOld } = compactAtBoundary(oldMessages)

      // 3. 构造摘要请求（独立数组，不 mutate this.context）
      const compactionContext: ChatMessage[] = [
        ...(systemMsg ? [systemMsg] : []),
        ...stripReasoningContent(governedOld),
        ...buildCompactionRequestTail(governedOld[governedOld.length - 1]?.role, recentMessages.length)
      ]

      // 4. 调用模型获取摘要
      let summary = ''
      const stream = this.modelPool.chat(compactionContext, undefined, {
        abortSignal: this.abortController?.signal,
        includeInternalMessages: true,
        expectedCacheMiss: true,
        ...(this.config.promptCacheKey ? { promptCacheKey: this.config.promptCacheKey } : {})
      })
      for await (const event of stream) {
        if (this.cancelled) {
          restorePulledBack()
          return false
        }
        if (event.type === 'text_delta') {
          summary += event.delta
        }
        if (event.type === 'wire_snapshot') {
          this.cacheDiagnostics.recordWireSnapshot(event.snapshot, { expectedMiss: true })
        }
        if (event.type === 'context_overflow') {
          restorePulledBack()
          return false
        }
        if (event.type === 'error') {
          restorePulledBack()
          return false
        }
      }

      if (!summary.trim()) {
        restorePulledBack()
        return false
      }

      // 5. 重建上下文 + 压缩后簿记
      this.applyCompactionResult(systemPrompt, summary.trim(), recentMessages, pulledBackMessages)

      this.config.onCompaction?.(this.context, {
        summary: summary.trim(),
        compactionLevel: this.compactionLevel,
        trigger: 'overflow'
      })

      return true
    } catch {
      restorePulledBack()
      return false
    } finally {
      this.compressingForOverflow = false
    }
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
   * abort 时不回滚 context：依赖 runCompaction 在替换 context 前检查 abortSignal，
   * abort 则直接 return 不替换。这样压缩期间 sendMessage 推入的新消息自然保留，
   * 避免回滚方案把并发推入的新消息一并回滚掉。
   *
   * 独立 AbortController 通过 signal 转发与 timer 的 abort 联动，
   * 不与主循环的 abortController 混用，避免 cancel 时误杀正常 LLM 调用。
   */
  async runIdleCompaction(abortSignal: AbortSignal): Promise<void> {
    // 开始置位，finally 清零；与 timer 层 _compressing 互补，供资格预筛阻断重复调度
    this.idleCompactionInProgress = true
    const prevAbortController = this.abortController
    const prevCancelled = this.cancelled
    const prevOverflowFlag = this.compressingForOverflow
    const onAbort = () => this.abortController?.abort()

    try {
      this.abortController = new AbortController()
      abortSignal.addEventListener('abort', onAbort, { once: true })
      this.cancelled = false
      this.compressingForOverflow = false
      await this.runCompaction(abortSignal, 'idle')
    } finally {
      abortSignal.removeEventListener('abort', onAbort)
      this.abortController = prevAbortController
      this.cancelled = prevCancelled
      this.compressingForOverflow = prevOverflowFlag
      this.idleCompactionInProgress = false
    }
  }
}
