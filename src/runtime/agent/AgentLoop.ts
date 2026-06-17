/**
 * AgentLoop — 核心消息-模型-工具循环
 * 接收用户消息，组织上下文，调用模型，处理工具调用，通过 EventBus 向外发射流式事件
 *
 * S3 阶段：纯文本对话循环（消息 → 模型 → 响应）
 * S4 阶段：加入工具调度（tool_call → 执行 → 结果回模型 → 重复）
 * S6 阶段：加入 checkpoint 备份和 plan 模式写入拦截
 * S7 阶段：加入 PermissionManager 权限决策
 */
import type { ModelClient } from '../model/ModelClient'
import { ModelClientPool } from '../model/ModelClientPool'
import { decideFallback } from './FallbackDecider'
import { MAX_RETRY_ATTEMPTS } from './RecoveryStateMachine'
import type { ChatMessage, ChatToolCall, ContentBlock } from '../model/types'
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
import { shouldCompact, splitForCompaction, buildCompactionPrompt, rebuildWithCompression, MIN_RECENT_MESSAGES, getCompactionThreshold, rollbackBefore } from './compaction'
import { ageToolResults } from './toolResultAging'
import { CacheDiagnostics } from '../model/cacheDiagnostics'
import { randomUUID } from 'crypto'
import { estimateContextTokens } from './tokenEstimator'
import { executeToolBatch, toToolContent } from './toolBatchExecutor'
import { IdleCompressionTimer } from './IdleCompressionTimer'
import type { IdleCompactionTarget } from './IdleCompressionTimer'
import { HookManager } from './HookManager'
import { RecoveryStateMachine } from './RecoveryStateMachine'
import { SystemPromptBuilder } from './SystemPromptBuilder'
import { buildStableSystemPrompt, normalizeFrozenSystemPrompt } from './modePrompt'
import { buildSessionContext } from './sessionContext'
import { calculateContextBreakdown } from './contextBreakdownCalculator'
import { preferredToolDialect, type ToolDialect } from '../model/dialect'
import { XmlToolScanner, stripMinimaxArtifacts, parseXmlToolCalls, type ScannedToolCall as XmlScannedToolCall } from './xmlToolScanner'
import type { SkillRegistry } from '../skills/SkillRegistry'
import { parseTextToolCalls } from '../../shared/tool-call-text-fallback'
import { runSkillFork, type RunSkillForkDeps } from '../skills/runSkillFork'
import { createReadState, type ReadState } from '../tools/editTool'
import type { ArtifactStore } from '../artifacts/ArtifactStore'

import { invokeSkill } from '../skills/invokeSkill'
import { getModeInstruction } from './modeInstruction'
/**
 * 表示权限请求被 cancel 中断的 sentinel 错误。
 * 用于 checkPermission 区分"用户主动拒绝"（产生"权限拒绝"工具结果）
 * 和"流程被取消"（不产生任何 tool_result，不污染 context 与持久化）。
 */
/** 写入类工具名称集合，plan 模式下会被拒绝 */
const WRITE_TOOLS: Record<string, true> = {
  edit: true,
  write: true,
  bash: true
}

class PermissionAbortedError extends Error {
  constructor() {
    super('permission request aborted by cancel')
    this.name = 'PermissionAbortedError'
  }
}

export class AgentLoop implements IdleCompactionTarget {
  /**
   * PRD §5.4：modelClient 改为 ModelClientPool。
   * 即便未配置 fallback，也包装成只含主模型的 pool，对外接口不变。
   */
  private modelPool: ModelClientPool
  private eventBus: EventBus
  private config: AgentLoopConfig
  private state: AgentState = 'idle'
  /** 独立的取消标志，因为 cancel() 可从外部异步调用，TS 控制流无法感知 */
  private cancelled = false
  private abortController: AbortController | null = null

  /** 对话上下文：累积所有消息用于下一次模型调用 */
  private context: ChatMessage[] = []

  /** 工具注册表 */
  private toolRegistry: ToolRegistry | null = null

  /** 工作区路径（传入后工具执行才有工作区边界） */
  private workingDir: string | null = null

  /** bash 工具的自定义 shell 路径（可选） */
  private shellPath: string | undefined = undefined

  /** bash 工具的 PATH 注入目录（可选） */
  private binDirs: string[] = []

  /** 运行模式（plan / default / auto） */
  private mode: Mode = 'default'

  /** checkpoint 管理器（可选，S6 引入） */
  private checkpointManager: CheckpointManager | null = null
  /** 当前工具调用方言，由模型 ID 决定 */
  private toolDialect: ToolDialect = 'xml'

  /** 权限决策引擎（可选，S7 引入） */
  private permissionManager: PermissionManager | null = null

  /** 会话级状态存储（透传给 todo_write 等需要写会话元数据的工具） */
  private sessionStore: SessionStore | null = null

  /** 当前会话 ID，与 sessionStore 配套 */
  private sessionId: string | null = null

  /** 会话级 artifact 存储（大输出落盘，透传给工具执行层） */
  private artifactStore: ArtifactStore | null = null

  /** 技能正文层独立 token 估算，作为'技能'分项桶的预算 */
  private skillsTokenBudget: number = 0

  /** 等待用户确认的权限请求（requestId → { resolve, reject } 回调） */
  private pendingPermissions: Map<
    string,
    { resolve: (granted: boolean) => void; reject: (err: Error) => void }
  > = new Map()

  /** 最大工具调用轮数（可动态调整） */
  private maxToolRounds: number

  /** 缓存诊断跟踪器：检测 system prompt / 工具定义变化导致的缓存失效 */
  private cacheDiagnostics = new CacheDiagnostics()

  /** 截断管道：用于工具输出超限时进行结构化截断 */
  private truncationPipeline = createTruncationPipeline()

  /** 上下文溢出重试标志（防止同一轮无限循环） */
  private contextOverflowRetryAttempted = false
  /** 是否正在执行溢出压缩（用于守卫正常压缩逻辑） */
  private compressingForOverflow = false
  /** 缓存上次估算的 token 数，用于判断守卫 */
  private lastEstimatedTokens = 0
  /** 距上次压缩后的 user 消息回合数（软触发冷却） */
  private userTurnsSinceCompaction = 0
  /** 压缩层级计数 */
  private compactionLevel = 0

  /** 空闲压缩计时器（惰性创建） */
  private idleTimer: IdleCompressionTimer | null = null

  /** Hook 编排层（与 EventBus 并行，负责干预） */
  private hookManager: HookManager

  /** 错误恢复状态机 */
  private recovery = new RecoveryStateMachine()

  /** 冻结的 system prompt（6 层拼装结果） */
  private frozenSystemPrompt: string

  /** 当前轮次 messageId（cancel / onCancel 使用） */
  private currentMessageId: string | null = null

  /** 模型临时错误重试计数 */
  private modelErrorAttempt = 0

  /** 统一 skill 调度：slash inject / fork */
  private skillRegistry: SkillRegistry | null = null
  private skillForkDeps: RunSkillForkDeps | null = null

  /**
   * 文件读取状态：记录"已 read 过哪些文件"，edit/write 工具的"先读后改"校验依赖此。
   * 默认实例化一个独立的 readState；agentHandler 注入主 readState（跨 SEND_MESSAGE 复用），
   * sub agent 在 taskTool / runSkillFork 中 clone 主 readState 隔离。
   */
  private readState: ReadState = createReadState()

  /**
   * 重复失败熔断计数：signature(toolName + 参数) → 失败次数。
   * 用于检测模型对「完全相同的工具调用」反复触发并反复失败的死循环
   * （典型场景：edit 因 readState 键不一致一直报 "File has not been read yet"，
   * 模型 read→edit→失败→read 无限重试，最终把渲染进程拖垮 / OOM）。
   * 每条用户消息开始时清空。
   */
  private repeatedFailureCounts = new Map<string, number>()
  /** 同一签名工具调用累计失败达到该次数即熔断，停止本轮循环 */
  private static readonly REPEATED_FAILURE_LIMIT = 3

  constructor(
    modelClient: ModelClient | ModelClientPool,
    eventBus: EventBus,
    config?: AgentLoopConfig
  ) {
    // PRD §5.4：统一包装成 ModelClientPool（单个 ModelClient 时无 fallback）
    this.modelPool = modelClient instanceof ModelClientPool
      ? modelClient
      : new ModelClientPool({ primary: modelClient, primaryConfig: { baseUrl: '', apiKey: '', modelId: 'primary' } })
    // 根据当前主模型决定工具调用方言
    const primaryProvider = this.modelPool.getActiveProvider()
    this.toolDialect = preferredToolDialect(primaryProvider.modelId, primaryProvider.baseUrl)
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
      skillsTokenEstimate: config?.skillsTokenEstimate
    }
    /** 技能正文独立 token 桶（来自 skillContext 拼装时一次性估算） */
    this.skillsTokenBudget = Math.max(0, config?.skillsTokenEstimate ?? 0)
    this.maxToolRounds = this.config.maxToolRounds ?? 20
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
        messages: this.context
          .filter(m => m.role !== 'system')
          .map(m => this.toSessionMessageForBreakdown(m)),
        frozenSystemPrompt: this.frozenSystemPrompt,
        schemaVersion: 2,
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      skills: this.skillsTokenBudget,
      toolDefinitions: this.toolRegistry?.getToolDefinitions() ?? [],
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
  private toSessionMessageForBreakdown(m: ChatMessage): import('../sessions/types').SessionMessage {
    return {
      id: '',
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

  /** 设置工具注册表 */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry
  }

  /** 设置工作区路径（工具执行时的边界目录） */
  setWorkingDir(dir: string): void {
    this.workingDir = dir
    // 无须显式重置 session context：getSessionContextPrefix 扫描 context 时会
    // 发现旧锚点的 Working directory ≠ 新 dir，自动触发重新拼接。
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

  /** 注入 fork skill 执行依赖 */
  setSkillForkDeps(deps: RunSkillForkDeps | null): void {
    this.skillForkDeps = deps
  }

  /**
   * 注入主 readState（由 agentHandler 调用，跨 SEND_MESSAGE 复用）。
   * 不调用时使用 loop 自带的独立实例（用于 sub agent 隔离测试）。
   */
  setReadState(rs: ReadState): void {
    this.readState = rs
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
    this.contextOverflowRetryAttempted = false
    this.repeatedFailureCounts.clear()
    this.modelErrorAttempt = 0
    // PRD §5.4.5：每条新消息开始时重置回主模型（降级不影响下一轮）
    this.modelPool.resetToPrimary()

    // 空闲压缩：新消息到达时取消任何正在运行的压缩
    this.idleTimer?.cancel()

    // 开启 checkpoint 事务边界
    this.checkpointManager?.beginMessage(messageId)

    this.eventBus.emit({ type: 'message_start', messageId })

    const modeInstruction = getModeInstruction(this.mode)
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
      const dispatch = invokeSkill({
        input: content,
        registry: this.skillRegistry!,
        profile: this.mode,
        templateContext: { workspacePath: this.workingDir ?? undefined }
      })

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
          // S1：error 状态取消 idleTimer，避免 266s 后台压缩污染损坏 context
          this.idleTimer?.cancel()
          this.idleTimer = null
          return
        }
        await this.finishMessageRound(messageId)
        return
      }

      if (dispatch.kind === 'inject') {
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

    // 旧工具结果老化 + 刷新 token 估算（在 shouldCompact 之前）
    this.context = ageToolResults(this.context)
    this.lastEstimatedTokens = estimateContextTokens(this.context)

    try {
      let toolRound = 0

      while (toolRound < this.maxToolRounds) {
        if (this.cancelled) break

        let shouldRetryChat = false
        /** 本轮 model response 是否收到 usage 事件，用于兜底推送 context_breakdown */
        let roundSawUsage = false

        const beforeAgent = await this.hookManager.trigger({
          event: 'beforeAgentStart',
          messageId,
          prompt: userText,
          systemPrompt: this.frozenSystemPrompt
        })
        if (beforeAgent?.messages) this.context = beforeAgent.messages
        if (beforeAgent?.systemPrompt) {
          this.frozenSystemPrompt = beforeAgent.systemPrompt
          const sysIdx = this.context.findIndex(m => m.role === 'system')
          if (sysIdx >= 0) {
            this.context[sysIdx] = { role: 'system', content: beforeAgent.systemPrompt }
          }
        }

        // 上下文压缩检查：跳过正在执行溢出压缩的轮次
        if (!this.compressingForOverflow) {
          const compactionThreshold = getCompactionThreshold(this.config.contextWindow ?? 200_000)
          // 2.4 守卫：使用上轮估算/API实际报告的 token 数和当前实时估算中的较大值作为判断依据，防范反复触发
          const currentTokens = estimateContextTokens(this.context)
          const tokensToCompare = Math.max(currentTokens, this.lastEstimatedTokens)
          if (shouldCompact(this.context, compactionThreshold, tokensToCompare, this.userTurnsSinceCompaction)) {
            await this.runCompaction()
          }
        }

        // 获取工具定义（如果有 registry），始终传全部工具（缓存 Harness：工具集恒定）
        // 写操作约束完全由权限层（getBaseDecision / PermissionManager）控制
        const tools = this.toolRegistry?.getToolDefinitions()

        // 缓存诊断：记录本轮请求的基线（system prompt + 工具定义哈希）
        const systemPrompt = extractTextFromContent(
          this.context.find(m => m.role === 'system')?.content ?? ''
        )
        this.cacheDiagnostics.recordBaseline(systemPrompt, tools)

        const contextHook = await this.hookManager.trigger({
          event: 'context',
          messageId,
          messages: [...this.context]
        })
        let chatMessages = contextHook?.messages ?? this.context

        const preChatHook = await this.hookManager.trigger({
          event: 'preChat',
          messageId,
          messages: [...chatMessages]
        })
        chatMessages = preChatHook?.messages ?? chatMessages

        // 调用模型，获取流式响应，传入 abort signal 实现真正的取消
        const stream = this.modelPool.chat(chatMessages, tools, {
          abortSignal: this.abortController?.signal
        })

        let assistantContent = ''
        const toolCalls: ChatToolCall[] = []
        let finishReason = ''

        for await (const event of stream) {
          if (this.cancelled) break

          switch (event.type) {
            case 'thinking_delta':
              this.eventBus.emit({ type: 'thinking_delta', messageId, delta: event.delta })
              break

            case 'text_delta':
              assistantContent += event.delta
              this.eventBus.emit({ type: 'text_delta', messageId, delta: event.delta })
              break

            case 'tool_call_start': {
              this.eventBus.emit({
                type: 'tool_call_start',
                messageId,
                toolCallId: event.toolCallId,
                toolName: event.toolName
              })
              break
            }

            case 'tool_call_delta': {
              this.eventBus.emit({
                type: 'tool_call_delta',
                messageId,
                toolCallId: event.toolCallId,
                argumentsDelta: event.argumentsDelta
              })
              break
            }

            case 'tool_call': {
              toolCalls.push(event.toolCall)
              this.eventBus.emit({
                type: 'tool_call',
                messageId,
                toolCallId: event.toolCall.id,
                toolName: event.toolCall.name,
                args: JSON.parse(event.toolCall.arguments || '{}')
              })
              break
            }

            case 'cancelled':
              // 模型请求被取消，跳出循环进入 cancelled 结束态
              this.cancelled = true
              break

            case 'context_overflow': {
              const overflowState = this.recovery.classify(event.rawError, this.modelErrorAttempt)
              this.eventBus.emit({ type: 'recovery_state', messageId, state: overflowState })
              await this.hookManager.trigger({ event: 'onError', messageId, error: event.rawError })

              if (this.contextOverflowRetryAttempted && overflowState.kind === 'failed') {
                this.eventBus.emit({ type: 'error', messageId, error: event.rawError })
                this.state = 'error'
                // S1：context_overflow 最终失败等同 error，取消 idleTimer
                this.idleTimer?.cancel()
                this.idleTimer = null
                return
              }
              this.contextOverflowRetryAttempted = true

              if (overflowState.kind === 'recovering') {
                const hint = this.recovery.buildRecoveryHint(overflowState)
                this.eventBus.emit({ type: 'recovery_hint', messageId, hint, attempt: this.modelErrorAttempt })
              }

              const standardOk = await this.runOverflowCompaction('standard')
              if (standardOk) {
                shouldRetryChat = true
                break
              }

              const aggressiveOk = await this.runOverflowCompaction('aggressive')
              if (aggressiveOk) {
                shouldRetryChat = true
                break
              }

              this.eventBus.emit({ type: 'error', messageId, error: event.rawError })
              this.state = 'error'
              // S1：所有 overflow 压缩失败路径都取消 idleTimer，避免后台压缩污染
              this.idleTimer?.cancel()
              this.idleTimer = null
              return
            }

            case 'error': {
              const errState = this.recovery.classify(event.error, this.modelErrorAttempt)
              this.eventBus.emit({ type: 'recovery_state', messageId, state: errState })
              await this.hookManager.trigger({ event: 'onError', messageId, error: event.error })

              if (errState.kind === 'retrying' && this.recovery.shouldRetry(errState)) {
                this.modelErrorAttempt = errState.attempt
                const hint = this.recovery.buildRecoveryHint(errState)
                this.eventBus.emit({ type: 'recovery_hint', messageId, hint, attempt: errState.attempt })
                await this.sleep(this.recovery.backoffMs(errState.attempt))
                shouldRetryChat = true
                break
              }

              // PRD §5.4：重试链耗尽后，由 FallbackDecider 判定是否切换 fallback 模型。
              // RecoveryStateMachine 保持四态不变，降级决策与之正交。
              const fallbackDecision = decideFallback({
                currentError: event.error,
                retryAttempt: this.modelErrorAttempt,
                maxAttempts: MAX_RETRY_ATTEMPTS, // 引用常量，避免硬编码不一致
                currentFallbackIndex: this.modelPool.getActiveFallbackIndex(),
                availableFallbackCount: this.modelPool.getFallbackCount()
              })
              if (fallbackDecision.shouldFallback && fallbackDecision.nextFallbackIndex !== undefined) {
                const nextIndex = fallbackDecision.nextFallbackIndex
                this.modelPool.switchToFallback(nextIndex)
                // 对新模型重新开始重试链
                this.modelErrorAttempt = 0
                const provider = this.modelPool.getActiveProvider()
                this.eventBus.emit({
                  type: 'model_switched',
                  messageId,
                  modelId: provider.modelId,
                  fallbackIndex: provider.fallbackIndex,
                  reason: fallbackDecision.reason
                })
                // 切换后立即重试（不等待）
                shouldRetryChat = true
                break
              }

              this.eventBus.emit({ type: 'error', messageId, error: event.error })
              this.state = 'error'
              // S1：模型错误重试耗尽后取消 idleTimer
              this.idleTimer?.cancel()
              this.idleTimer = null
              return
            }

            case 'usage':
              roundSawUsage = true
              this.eventBus.emit({ type: 'usage', messageId, usage: event.usage })
              // 缓存诊断：检查 cache_read_tokens 是否显著下降
              {
                const diag = this.cacheDiagnostics.checkResponse(
                  event.usage.cachedTokens,
                  extractTextFromContent(
                    this.context.find(m => m.role === 'system')?.content ?? ''
                  ),
                  this.toolRegistry?.getToolDefinitions()
                )
                if (diag.cacheBreakDetected) {
                  this.eventBus.emit({ type: 'cache_diagnostic', messageId, diagnostic: diag })
                }
              }
              this.emitContextBreakdown(messageId, event.usage.promptTokens)
              break

            case 'message_end':
              finishReason = event.finishReason
              break
          }
        }

        if (this.cancelled) break

        if (shouldRetryChat) {
          continue
        }

        // 工具调用兜底：
        // - XML 方言：模型把调用以 <invoke> 形式写在正文里，scanner 边流边识别。
        // - 原生 tool_calls：已经被上面的 case 'tool_call' 收集到 toolCalls 中。
        // - 如果都没有，再尝试识别行内 JSON / fenced JSON / MiniMax 占位符中的调用。
        if (toolCalls.length === 0) {
          const xmlParsed = parseXmlToolCalls(stripMinimaxArtifacts(assistantContent))
          if (xmlParsed.toolCalls.length > 0) {
            assistantContent = xmlParsed.visibleText
            finishReason = 'tool_calls'
            for (const call of xmlParsed.toolCalls) {
              const syntheticToolCall: ChatToolCall = {
                id: `call_${randomUUID()}`,
                name: call.name,
                arguments: JSON.stringify(call.arguments)
              }
              toolCalls.push(syntheticToolCall)
              this.eventBus.emit({
                type: 'tool_call_start',
                messageId,
                toolCallId: syntheticToolCall.id,
                toolName: syntheticToolCall.name
              })
              this.eventBus.emit({
                type: 'tool_call',
                messageId,
                toolCallId: syntheticToolCall.id,
                toolName: syntheticToolCall.name,
                args: call.arguments
              })
            }
          } else {
            // 兜底：行内 JSON / fenced JSON（不含 MiniMax 占位符的情况）
            const fallback = parseTextToolCalls(stripMinimaxArtifacts(assistantContent))
            if (fallback && fallback.toolCalls.length > 0) {
              assistantContent = fallback.visibleText
              finishReason = 'tool_calls'
              for (const parsed of fallback.toolCalls) {
                const syntheticToolCall: ChatToolCall = {
                  id: `call_${randomUUID()}`,
                  name: parsed.toolName,
                  arguments: JSON.stringify(parsed.arguments)
                }
                toolCalls.push(syntheticToolCall)
                this.eventBus.emit({
                  type: 'tool_call_start',
                  messageId,
                  toolCallId: syntheticToolCall.id,
                  toolName: syntheticToolCall.name
                })
                this.eventBus.emit({
                  type: 'tool_call',
                  messageId,
                  toolCallId: syntheticToolCall.id,
                  toolName: syntheticToolCall.name,
                  args: parsed.arguments
                })
              }
            }
          }
        }

        // 将 assistant 回复（含 tool_calls）加入上下文
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: assistantContent
        }
        if (toolCalls.length > 0) {
          assistantMsg.toolCalls = toolCalls
        }
        this.context.push(assistantMsg)

        // 每次成功调用模型后更新估算 token 计数
        this.lastEstimatedTokens = estimateContextTokens(this.context)
        // 兜底：本轮 model response 没收到 usage 事件（部分 provider 不报）时，补一次分项推送
        if (!roundSawUsage) {
          this.emitContextBreakdown(messageId, 0)
        }

        await this.hookManager.trigger({ event: 'postMessage', messageId, message: assistantMsg })

        // 如果模型没有调用工具，本轮结束
        if (toolCalls.length === 0 || finishReason !== 'tool_calls') {
          break
        }

        // 执行所有工具调用，将结果加入上下文
        toolRound++
        const batchResult = await executeToolBatch({
          toolCalls,
          messageId,
          toolRegistry: this.toolRegistry,
          workingDir: this.workingDir ?? process.cwd(),
          mode: this.mode,
          shellPath: this.shellPath,
          binDirs: this.binDirs,
          supportsVision: this.config.supportsVision ?? true,
          checkpointManager: this.checkpointManager,
          abortSignal: this.abortController?.signal,
          checkPermission: (toolName, args, currentMessageId) =>
            this.checkPermission(toolName, args, currentMessageId),
          emit: (event) => this.eventBus.emit(event),
          applyTruncation: (output, maxSize) => this.applyTruncation(output, maxSize),
          maxParallelToolCalls: this.config.maxParallelToolCalls ?? 4,
          toolExecution: this.config.toolExecution ?? 'parallel',
          sessionStore: this.sessionStore,
          sessionId: this.sessionId,
          eventBus: this.eventBus,
          hookManager: this.hookManager,
          readState: this.readState,
          artifactStore: this.artifactStore
        })

        if (!batchResult.aborted && !this.cancelled && !this.abortController?.signal.aborted) {
          for (const outcome of batchResult.outcomes) {
            if (outcome.skippedByAbort) continue
            this.context.push({
              role: 'tool',
              content: toToolContent(outcome.resultText, outcome.resultImages),
              toolCallId: outcome.toolCall.id,
              ...(outcome.artifactId ? { artifactId: outcome.artifactId } : {}),
              ...(outcome.truncationMeta ? { truncationMeta: outcome.truncationMeta } : {})
            })
          }
        }

        if (batchResult.aborted || this.cancelled || this.abortController?.signal.aborted) {
          this.cancelled = true
          break
        }

        // 熔断：检测对同一工具调用（名称 + 参数完全一致）的重复失败。
        // 命中后停止本轮循环，避免模型在无效调用上空转烧光 maxToolRounds，
        // 同时把海量流式事件灌向渲染进程导致卡顿 / OOM 白屏。
        const stuckTool = this.trackRepeatedFailures(batchResult.outcomes)
        if (stuckTool) {
          const notice =
            `\n\n[已自动中断] 检测到对「${stuckTool}」的相同调用连续失败 ` +
            `${AgentLoop.REPEATED_FAILURE_LIMIT} 次，已停止本轮以避免无效循环。` +
            `请查看上方的工具错误信息后再调整指令。`
          // 通过 text_delta 下发：renderer 追加展示，累积器并入持久化内容，口径一致
          this.eventBus.emit({ type: 'text_delta', messageId, delta: notice })
          break
        }

        // 继续下一轮模型调用（带着工具结果）
      }
    } catch (err) {
      if (!this.cancelled) {
        const errMsg = (err as Error).message
        await this.hookManager.trigger({ event: 'onError', messageId, error: errMsg })
        this.eventBus.emit({ type: 'error', messageId, error: errMsg })
        this.state = 'error'
        // S1：错误状态下不启动 idleTimer。
        // 错误意味着本轮已损坏（context 可能是不完整状态），266s 后触发压缩只会
        // 把损坏内容发给模型烧 token，且压缩后状态可能进一步污染下一次对话。
        // 用户回来时应主动 sendMessage 触发新一轮，而不是后台悄悄压缩。
        return
      }
    }

    await this.finishMessageRound(messageId)
  }

  /** 结束一轮消息：checkpoint 收尾、message_end、空闲压缩计时 */
  private async finishMessageRound(messageId: string): Promise<void> {
    if (this.state === 'running') {
      this.state = 'idle'
    }

    this.checkpointManager?.endMessage()

    if (this.cancelled && this.currentMessageId) {
      await this.hookManager.trigger({
        event: 'onCancel',
        messageId: this.currentMessageId,
        interrupted: true
      })
    }
    this.currentMessageId = null

    this.eventBus.emit({
      type: 'message_end',
      messageId,
      ...(this.cancelled ? { interrupted: true } : {})
    })

    // S1：cancel 状态下不启动 idleTimer。
    // 用户主动取消通常意味着模型走偏，启动后台压缩既浪费 token 又可能在用户
    // 不知情时改写 context（再次进入会话发现历史已被压缩）。让用户主动发起下一条消息。
    if (!this.cancelled) {
      this.idleTimer ??= new IdleCompressionTimer(this)
      this.idleTimer.start()
    }
  }

  /**
   * 执行上下文压缩
   * 将旧消息发给模型生成摘要，然后用 [system, 摘要, 最近 N 条] 重建上下文。
   * 压缩调用本身复用现有缓存前缀（只追加压缩指令到尾部）。
   *
   * @param abortSignal 可选的 abort 信号：传入时会在替换 context 前检查，
   *   abort 则直接 return 不替换。这样压缩期间 sendMessage 推入的新消息能保留，
   *   避免之前 prevContext 回滚方案误删用户新消息的 bug（C4+）。
   */
  private async runCompaction(abortSignal?: AbortSignal): Promise<void> {
    const systemMsg = this.context.find(m => m.role === 'system')
    const systemPrompt = extractTextFromContent(systemMsg?.content ?? '')

    const { oldMessages, recentMessages } = splitForCompaction(this.context, MIN_RECENT_MESSAGES)
    if (oldMessages.length === 0) return

    // 构建压缩上下文：旧消息 + 压缩指令（追加到尾部，不改前缀）
    // 如果上下文末尾是 user 消息，先插入一条 assistant 占位避免连续 user（Anthropic 严格模式会拒绝）
    const lastMsg = this.context[this.context.length - 1]
    const needsAssistantBridge = lastMsg?.role === 'user'
    const compactionContext: ChatMessage[] = [
      ...this.context,
      ...(needsAssistantBridge
        ? [{ role: 'assistant' as const, content: '好的，我来总结之前的对话。' }]
        : []),
      // 压缩指令标记为 internal：跳过缓存标记，但 compaction 调用会显式放行正文，
      // 让模型真正看到摘要要求；internal 字段本身仍会在序列化层被剥离。
      { role: 'user' as const, content: buildCompactionPrompt(recentMessages.length), internal: true }
    ]

    // 调用模型生成摘要（非流式收集）
    let summary = ''
    try {
      const stream = this.modelPool.chat(compactionContext, undefined, {
        abortSignal: this.abortController?.signal,
        includeInternalMessages: true
      })
      for await (const event of stream) {
        if (this.cancelled) return
        if (event.type === 'text_delta') {
          summary += event.delta
        }
      }
    } catch {
      // 压缩失败不影响主流程，跳过本次压缩
      return
    }

    if (!summary.trim()) return

    // 关键：替换 context 前检查 abort，防止压缩期间用户 sendMessage 推入的新消息被覆盖。
    // runIdleCompaction 会传 abortSignal，主循环（line 436）的 runCompaction 不传。
    if (abortSignal?.aborted) return

    // 重建上下文
    this.context = rebuildWithCompression(systemPrompt, summary.trim(), recentMessages)
    this.compactionLevel++
    this.userTurnsSinceCompaction = 0
    this.lastEstimatedTokens = estimateContextTokens(this.context)

    // 缓存诊断：压缩后上下文完全改变，重置基线避免误报
    this.cacheDiagnostics.resetBaseline(
      extractTextFromContent(
        this.context.find(m => m.role === 'system')?.content ?? ''
      ),
      this.toolRegistry?.getToolDefinitions()
    )

    // onCompaction 回调前再检查一次：abort 后不应触发持久化，避免与主循环状态竞争
    if (abortSignal?.aborted) return
    // 通知外部持久化压缩态（agentHandler 写回 SessionStore）
    this.config.onCompaction?.(this.context)
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

  /**
   * 跟踪并检测重复失败的工具调用。
   *
   * 对每个非中断的工具结果计算签名（工具名 + 序列化参数）：
   * - 失败结果（"工具执行失败" / "权限拒绝:"）累加该签名的失败计数；
   * - 成功结果清零该签名计数（说明该调用已不再卡住）。
   *
   * 当任一签名累计失败次数达到 REPEATED_FAILURE_LIMIT，返回对应工具名表示需要熔断；
   * 否则返回 null。只有「参数完全相同」的调用才会累加，因此模型在迭代修复
   * （每次参数不同）时不会被误伤。
   *
   * @returns 触发熔断的工具名；未触发返回 null
   */
  private trackRepeatedFailures(
    outcomes: Array<{ toolCall: ChatToolCall; args: Record<string, unknown>; resultText: string; failed?: boolean; skippedByAbort?: boolean }>
  ): string | null {
    for (const outcome of outcomes) {
      if (outcome.skippedByAbort) continue

      // 用结构化的 failed 标记判定失败，而非从渲染后的中文 resultText 前缀反推，
      // 避免文案本地化 / 调整后熔断器静默失效，也能覆盖"未注册工具"等不以
      // "工具执行失败" 开头的错误结果。
      const failed = outcome.failed === true
      // 参数可能含大体量内容（如 write 的 content），签名做长度上限保护，
      // 仅用于「是否同一调用」的判定，过长时截断不影响判等的稳定性。
      let argsKey: string
      try {
        argsKey = JSON.stringify(outcome.args)
      } catch {
        argsKey = String(outcome.args)
      }
      const signature = `${outcome.toolCall.name}:${argsKey.slice(0, 4096)}`

      if (failed) {
        const next = (this.repeatedFailureCounts.get(signature) ?? 0) + 1
        this.repeatedFailureCounts.set(signature, next)
        if (next >= AgentLoop.REPEATED_FAILURE_LIMIT) {
          return outcome.toolCall.name
        }
      } else {
        this.repeatedFailureCounts.delete(signature)
      }
    }
    return null
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
      if (this.currentMessageId) {
        void this.hookManager.trigger({
          event: 'onCancel',
          messageId: this.currentMessageId,
          interrupted: true
        })
      }
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
   * - taskTool / runSkillFork 的子 agent 执行完后释放（C3）
   * - agentHandler 创建新 AgentLoop 前 dispose 旧的（I3）
   */
  dispose(): void {
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
   * 权限检查入口
   * 返回：
   * - { allowed: true }：可执行
   * - { allowed: false, reason }：用户主动拒绝或规则拒绝，需把"权限拒绝: {reason}"作为 tool_result 回传模型
   * - { aborted: true }：流程被 cancel 打断，调用方应跳过该工具的 tool_result 与 context 注入
   */
  private async checkPermission(
    toolName: string,
    args: Record<string, unknown>,
    messageId: string
  ): Promise<{ allowed: boolean; reason: string; aborted?: boolean }> {
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
      reason: result.reason
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
    let compressionPointIndex = -1
    const pulledBackMessages: ChatMessage[] = []

    const rollbackAndRestore = () => {
      if (compressionPointIndex >= 0) {
        this.context = rollbackBefore(this.context, compressionPointIndex)
      }
      pulledBackMessages.forEach(m => this.context.push(m))
    }

    try {
      // 1. 从 this.context 末尾弹出 pullBack 条消息
      for (let i = 0; i < pullBack && this.context.length > 2; i++) {
        const popped = this.context.pop()!
        if (popped.role !== 'system') {
          pulledBackMessages.unshift(popped)
        } else {
          this.context.push(popped) // 不弹 system，放回
          break
        }
      }

      // 2. 强制触发压缩
      const systemMsg = this.context.find(m => m.role === 'system')
      const systemPrompt = extractTextFromContent(systemMsg?.content ?? '')
      const { oldMessages, recentMessages } = splitForCompaction(this.context, MIN_RECENT_MESSAGES)

      if (oldMessages.length === 0) {
        // [修复] 当 oldMessages 为空早退时，将刚才弹出的 pulledBackMessages 推回，避免消息丢失
        pulledBackMessages.forEach(m => this.context.push(m))
        return false
      }

      // 3. 构建压缩上下文，追加到 this.context
      const lastMsg = this.context[this.context.length - 1]
      const needsAssistantBridge = lastMsg?.role === 'user'
      compressionPointIndex = this.context.length

      const compactionMessages: ChatMessage[] = [
        ...(needsAssistantBridge
          ? [{ role: 'assistant' as const, content: '好的，我来总结之前的对话。' }]
          : []),
        { role: 'user' as const, content: buildCompactionPrompt(recentMessages.length), internal: true }
      ]
      this.context.push(...compactionMessages)

      // 4. 调用模型获取摘要
      let summary = ''
      const stream = this.modelPool.chat(this.context, undefined, {
        abortSignal: this.abortController?.signal,
        includeInternalMessages: true
      })
      for await (const event of stream) {
        if (this.cancelled) {
          rollbackAndRestore()
          return false
        }
        if (event.type === 'text_delta') {
          summary += event.delta
        }
        if (event.type === 'context_overflow') {
          // 压缩调用本身也溢出了，回滚后返回 false 让上层升级到 aggressive
          rollbackAndRestore()
          return false
        }
        if (event.type === 'error') {
          rollbackAndRestore()
          return false
        }
      }

      if (!summary.trim()) {
        rollbackAndRestore()
        return false
      }

      // 5. 成功：重建上下文 + 追加 pulledBack
      this.context = rebuildWithCompression(systemPrompt, summary.trim(), recentMessages, pulledBackMessages)
      this.compactionLevel++
      this.userTurnsSinceCompaction = 0

      // 重置 token 估算，防止下轮立即重新触发压缩
      this.lastEstimatedTokens = estimateContextTokens(this.context)

      // 重置缓存诊断基线
      this.cacheDiagnostics.resetBaseline(
        extractTextFromContent(this.context.find(m => m.role === 'system')?.content ?? ''),
        this.toolRegistry?.getToolDefinitions()
      )

      // 通知外部持久化
      this.config.onCompaction?.(this.context)

      return true
    } catch {
      rollbackAndRestore()
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
   * 获取本轮 user 消息应拼接的 session context 前缀文本（合并方案）。
   *
   * 重注条件（v4 收口）：扫描当前 context，判断是否仍存在"与当前工作区/模型/日期完全一致"
   * 的 session context 前缀。只要有一条 user 消息仍保留这段前缀，就认为锚点仍在，
   * 无须重注。这统一处理了所有生命周期场景：
   * - 同日首轮：context 中无锚点 → 注入
   * - 同日后续轮：锚点仍在 context 中 → 跳过
   * - 跨天：旧锚点日期 ≠ today → 重注
   * - reset() 后：context 被清空 → 无锚点 → 重注
   * - 压缩后：带前缀的旧消息被摘要吃掉 → 锚点消失 → 重注
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
   *
   * 这比单纯记日期更健壮，统一处理所有生命周期场景：
   * - 同日后续轮：锚点仍在 context 中且完全匹配 → 跳过
   * - 跨天：旧锚点日期 ≠ today → 重注
   * - reset() 后：context 被清空 → 无锚点 → 重注
   * - 压缩后：带前缀的旧消息被摘要吃掉 → 锚点消失 → 重注
   * - setWorkingDir 后：旧锚点路径 ≠ 新 workingDir → 重注
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
   * 避免之前 prevContext 回滚方案把并发推入的新消息一并回滚掉的 bug（C4+）。
   *
   * 独立 AbortController 通过 signal 转发与 timer 的 abort 联动，
   * 不与主循环的 abortController 混用，避免 cancel 时误杀正常 LLM 调用。
   */
  async runIdleCompaction(abortSignal: AbortSignal): Promise<void> {
    const prevAbortController = this.abortController
    const prevCancelled = this.cancelled
    const prevOverflowFlag = this.compressingForOverflow
    const onAbort = () => this.abortController?.abort()

    try {
      this.abortController = new AbortController()
      abortSignal.addEventListener('abort', onAbort, { once: true })
      this.cancelled = false
      this.compressingForOverflow = false
      await this.runCompaction(abortSignal)
    } finally {
      abortSignal.removeEventListener('abort', onAbort)
      this.abortController = prevAbortController
      this.cancelled = prevCancelled
      this.compressingForOverflow = prevOverflowFlag
    }
  }
}
