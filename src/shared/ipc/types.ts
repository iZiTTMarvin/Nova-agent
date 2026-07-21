/**
 * IPC 命令和事件的类型定义
 * 保证 renderer → main 命令和 main → renderer 事件的端到端类型安全
 */
import type { Mode, PermissionDecision, Message, Session, SessionDetail } from '../session'
import type { ModelConfig, LlmRegistry } from '../config'
import type { DiffEntry, DiffReviewStatus, MessageDiffsState } from '../diff'
import type { NormalizedUsage } from '../model/types'
import type { HookEvent } from '../agent/types'
import type { ToolTruncationMeta } from '../tools/types'
import type { TodoItem, TodoViewInfo } from '../todo/types'
import type {
  SkillSummary,
  SkillCreateInput,
  SkillImportInput,
  SkillReloadResult
} from '../skills/types'
import type {
  NovaSettingsDto,
  RuleFileEntry,
  RulesListParams,
  RulesReadParams,
  RulesWriteParams,
  RulesCreateParams,
  SubagentListItem,
  SubagentsListParams,
  SubagentsSaveParams,
  SubagentsDeleteParams
} from '../settings/types'
import type {
  WorkspaceState,
  SelectProjectParams,
  CreateSessionParams,
  SetModeParams
} from '../workspace/types'
import type {
  StorageUsageReport,
  StorageCleanupResult
} from '../storage/types'
import type {
  PermissionRuleDto,
  PermissionListParams,
  PermissionUpsertParams,
  PermissionDeleteParams
} from '../permissions/types'
import type { AskQuestionItem, AskQuestionAnswer } from '../askQuestion/types'
import type {
  RunSnapshot,
  InteractionAnswerResult,
  ToolCommitRecord
} from '../run/types'
import type {
  MemoryScopeFileEntry,
  MemoryScopeStats,
  MemoryReadFileParams,
  MemoryWriteFileParams,
  ReconcileStats
} from '../memory/types'
import type { MainLoopLagSnapshot } from '../diagnostics/mainLoopLagTypes'

/**
 * 渲染端恢复状态（runtime RecoveryState 的 UI 子集）。
 * recovering 不含 snapshot: ChatMessage[]，避免大对象无意义穿透 IPC。
 */
export type RendererRecoveryState =
  | { kind: 'continuing' }
  | { kind: 'retrying'; attempt: number; lastError: string; maxAttempts: number }
  | { kind: 'recovering'; fromMessageId: string }
  | { kind: 'failed'; error: string }

// ── renderer → main 命令的参数和返回值 ──────────────────────

export interface IpcCommands {
  ping: {
    params: void
    result: string
  }
  'dev:main-loop-lag-snapshot': {
    params: void
    result: MainLoopLagSnapshot
  }
  'dev:main-loop-lag-reset': {
    params: void
    result: void
  }
  'dialog:confirm': {
    params: {
      type?: 'none' | 'info' | 'error' | 'question' | 'warning'
      buttons?: string[]
      defaultId?: number
      cancelId?: number
      title?: string
      message: string
      detail?: string
    }
    result: number
  }
  'select-project': {
    params: void
    result: string | null
  }
  'send-message': {
    params: {
      sessionId: string
      content: string
      /**
       * 渲染进程乐观追加的用户消息 id，主进程 appendMessage 必须复用，
       * 否则 UI 与磁盘 id 不一致会导致 edit-resend / diff 等按 id 查找失败。
       */
      userMessageId?: string
      images?: Array<{
        fileName: string
        /**
         * 图片引用。渲染层上传时已落盘，通常为 nova-image:// URL；
         * 主进程发给模型 API 时会临时读回 base64 data URL（模型不认识自定义协议）。
         */
        data: string
        mimeType: string
      }>
      /** true 时跳过用户消息 append，从当前 leaf（user）取内容重新生成 assistant */
      regenerate?: boolean
    }
    result: void
  }
  'cancel-execution': {
    /** 未传时保持兼容：取消主进程当前绑定的执行；传入时精确取消该 run。 */
    params: { runId?: string } | void
    /** 立即返回 cancelling 快照；终态需等 run:snapshot */
    result: { runId: string | null; status: string }
  }
  /** snapshot-first：按 session 拉取权威 Run 快照 */
  'run:get-snapshot': {
    params: { sessionId: string; runId?: string }
    result: {
      snapshot: RunSnapshot | null
      /** 同会话其他仍在等待的交互数（侧边栏徽标用全局 list-waiting） */
      waitingSessions: Array<{ sessionId: string; runId: string; pendingCount: number }>
    }
  }
  'run:list-waiting': {
    params: void
    result: Array<{ sessionId: string; runId: string; pendingCount: number }>
  }
  'run:force-terminate': {
    params: { runId: string }
    result: { ok: boolean; snapshot: RunSnapshot | null }
  }
  /** interrupted run 恢复入口 */
  'run:interrupted-action': {
    params: {
      runId: string
      action: 'continue' | 'rollback' | 'inspect'
    }
    result: {
      ok: boolean
      /** inspect：已执行工具步骤；continue/rollback：操作结果说明 */
      steps?: ToolCommitRecord[]
      message?: string
      snapshot?: RunSnapshot | null
    }
  }
  'save-model-config': {
    params: ModelConfig
    result: void
  }
  'load-model-config': {
    params: void
    result: ModelConfig | null
  }
  'load-llm-registry': {
    params: void
    result: LlmRegistry | null
  }
  'save-llm-registry': {
    params: LlmRegistry
    result: void
  }
  'set-active-model': {
    params: { providerId: string; modelEntryId: string }
    result: void
  }
  'fetch-provider-models': {
    params: { baseUrl: string; apiKey: string }
    result: { ok: true; modelIds: string[] } | { ok: false; message: string }
  }
  'set-mode': {
    params: { mode: Mode; sessionId?: string }
    result: void
  }
  'accept-file': {
    params: { sessionId: string; messageId: string; filePath: string }
    result: void
  }
  'get-message-diffs': {
    params: { sessionId: string; messageId: string }
    result: MessageDiffsState
  }
  'reject-file': {
    params: { sessionId: string; messageId: string; filePath: string }
    result: void
  }
  'respond-permission': {
    params: {
      requestId: string
      decision: PermissionDecision
      /** exactly-once 命令 id（可选，兼容旧调用） */
      commandId?: string
      expectedVersion?: number
      interactionId?: string
    }
    result: void | InteractionAnswerResult
  }
  'respond-verification-permission': {
    params: { requestId: string; granted: boolean }
    result: void
  }
  'respond-ask-question': {
    params: {
      requestId: string
      /** 用户提交的答案列表；用户 dismiss 时传空数组 */
      answers: AskQuestionAnswer[]
      commandId?: string
      expectedVersion?: number
      interactionId?: string
    }
    /** 旧调用方可忽略；新路径根据 ok 决定是否清除 pending */
    result: void | InteractionAnswerResult
  }
  'load-sessions': {
    params: void
    result: Session[]
  }
  'load-session': {
    params: { sessionId: string }
    result: SessionDetail
  }
  'load-session-messages': {
    params: { sessionId: string; beforeId?: string; limit: number }
    result: { messages: Message[]; hasMore: boolean }
  }
  'create-session': {
    params: { workspaceRoot: string; mode?: Mode }
    result: SessionDetail
  }
  'delete-session': {
    params: { sessionId: string }
    result: void
  }
  'window-minimize': {
    params: void
    result: void
  }
  'window-maximize': {
    params: void
    result: void
  }
  'window-close': {
    params: void
    result: void
  }
  'window-is-maximized': {
    params: void
    result: boolean
  }
  'skill:list': {
    params: void
    result: SkillSummary[]
  }
  'skill:get': {
    params: string
    result: SkillSummary | null
  }
  'skill:get-body': {
    params: string
    result: string | null
  }
  'skill:create': {
    params: SkillCreateInput
    result: SkillSummary
  }
  'skill:delete': {
    params: string
    result: void
  }
  'skill:toggle': {
    params: { name: string; enabled: boolean }
    result: SkillSummary
  }
  'skill:import': {
    params: SkillImportInput
    result: SkillSummary
  }
  'skill:export': {
    params: string
    result: { zipPath: string }
  }
  'skill:reload': {
    params: string | null | undefined
    result: SkillReloadResult
  }
  'skill:pick-import': {
    params: void
    result: string | null
  }
  'settings:get': {
    params: void
    result: NovaSettingsDto
  }
  'settings:set': {
    params: Partial<NovaSettingsDto>
    result: NovaSettingsDto
  }
  'rules:list': {
    params: RulesListParams
    result: RuleFileEntry[]
  }
  'rules:read': {
    params: RulesReadParams
    result: string
  }
  'rules:write': {
    params: RulesWriteParams
    result: void
  }
  'rules:create': {
    params: RulesCreateParams
    result: RuleFileEntry
  }
  'subagents:list': {
    params: SubagentsListParams
    result: SubagentListItem[]
  }
  'subagents:save': {
    params: SubagentsSaveParams
    result: SubagentListItem
  }
  'subagents:delete': {
    params: SubagentsDeleteParams
    result: void
  }
  // ── Workspace 单一事实源（PRD §5.1） ──
  'workspace:get': {
    params: void
    result: WorkspaceState
  }
  'workspace:select-project': {
    params: SelectProjectParams | void
    /** 返回新的工作区状态；用户取消选择对话框时仍返回当前状态 */
    result: WorkspaceState
  }
  'workspace:create-session': {
    params: CreateSessionParams
    result: WorkspaceState
  }
  'workspace:delete-session': {
    params: { sessionId: string }
    result: WorkspaceState
  }
  'workspace:rename-session': {
    params: { sessionId: string; title: string }
    result: WorkspaceState
  }
  'workspace:select-session': {
    params: { sessionId: string }
    result: WorkspaceState
  }
  'workspace:set-mode': {
    params: SetModeParams
    result: WorkspaceState
  }
  'workspace:regenerate': {
    params: { sessionId: string; messageId: string }
    result: WorkspaceState
  }
  'workspace:switch-branch': {
    params: { sessionId: string; targetMessageId: string }
    result: WorkspaceState
  }
  'workspace:bump-messages-revision': {
    params: void
    result: WorkspaceState
  }
  'workspace:edit-resend': {
    params: { sessionId: string; messageId: string }
    result: WorkspaceState
  }
  // ── 权限持久化规则（PRD §5.2） ──
  'permission:list': {
    params: PermissionListParams
    result: PermissionRuleDto[]
  }
  'permission:upsert': {
    params: PermissionUpsertParams
    result: PermissionRuleDto
  }
  'permission:delete': {
    params: PermissionDeleteParams
    result: { deleted: boolean }
  }
  'permission:grant-session-scope': {
    params: { sessionId: string; commandPrefix: string }
    result: void
  }
  // ── DiffViewer 批量审阅（PRD §5.3） ──
  'accept-all-files': {
    params: { sessionId: string; messageId: string; filePaths: string[] }
    result: void
  }
  'reject-all-files': {
    params: { sessionId: string; messageId: string; filePaths: string[] }
    result: { restored: string[]; failed: Array<{ filePath: string; error: string }> }
  }
  // ── 存储治理（WS3 后端） ──
  'storage:usage': {
    params: void
    result: StorageUsageReport
  }
  'storage:prune-session-checkpoints': {
    params: { sessionId: string }
    result: StorageCleanupResult
  }
  'storage:prune-all-checkpoints': {
    params: void
    result: StorageCleanupResult
  }
  'storage:delete-session': {
    params: { sessionId: string }
    result: StorageCleanupResult
  }
  'storage:run-gc': {
    params: { snapshotRetentionDays?: number }
    result: StorageCleanupResult
  }
  // ── 编排模式 compose ──
  'compose:run': {
    params: { scriptName: string; args?: string; workspaceRoot: string; sessionId?: string }
    result: { runId: string; status: string }
  }
  'compose:cancel': {
    params: { runId: string }
    result: { cancelled: boolean }
  }
  'compose:status': {
    params: { runId: string }
    result: { runId: string; status: string; phase?: string } | null
  }
  'compose:resume': {
    params: {
      runId: string
      scriptName: string
      args?: string
      workspaceRoot: string
      sessionId?: string
      /** 从指定 step 起重跑（v2） */
      rerunFromStepId?: string
      /** 脚本源变化时：migrate 显式清 journal/steps */
      scriptShaMismatch?: 'reject' | 'migrate'
    }
    result: { runId: string; status: string }
  }
  'compose:respond-ask-user': {
    params: { runId: string; requestId: string; answer: string; commandId?: string }
    result: { ok: boolean }
  }
  'compose:get-state': {
    params: { workspaceRoot: string; runId?: string }
    result: Record<string, unknown> | null
  }
  'compose:inspect-resume': {
    params: { workspaceRoot: string; runId: string; rerunFromStepId?: string }
    result: {
      engine: 'v1' | 'v2'
      skip: Array<{ stepId: string; kind: string; status: string }>
      run: Array<{ stepId: string; kind: string; status: string }>
      blocked: Array<{ stepId: string; kind: string; error?: string }>
    } | null
  }
  'compose:rollback': {
    params: { workspaceRoot: string; runId: string; sessionId?: string }
    result: { ok: boolean; error?: string; restored?: number }
  }
  'compose:new-analysis': {
    params: {
      scriptName: string
      args?: string
      workspaceRoot: string
      sessionId?: string
    }
    result: { runId: string; status: string }
  }
  // ── 跨会话记忆（P2-1 可观测/可编辑）──
  'memory:list-files': {
    params: void
    result: MemoryScopeFileEntry[]
  }
  'memory:read-file': {
    params: MemoryReadFileParams
    result: string
  }
  'memory:write-file': {
    params: MemoryWriteFileParams
    result: void
  }
  'memory:reconcile': {
    params: void
    result: ReconcileStats
  }
  'memory:stats': {
    params: void
    result: MemoryScopeStats
  }
  'memory:open-dir': {
    params: void
    result: void
  }
  'app:install-update': {
    params: void
    result: void
  }
  'image:save': {
    params: {
      sessionId: string
      fileName: string
      /** base64 data URL（data:{mime};base64,...），主进程写盘后不再持有 */
      dataUrl: string
      mimeType: string
    }
    result: {
      /** nova-image:// URL，渲染层 <img src> 与持久化引用 */
      url: string
    }
  }
}

/** 所有命令 channel 名称 */
export type IpcCommandChannel = keyof IpcCommands

// ── main → renderer 事件的数据类型 ──────────────────────

export interface IpcEvents {
  'agent:message-start': {
    messageId: string
  }
  'agent:text-delta': {
    messageId: string
    delta: string
  }
  'agent:tool-call-start': {
    messageId: string
    toolCallId: string
    toolName: string
  }
  'agent:tool-call-delta': {
    messageId: string
    toolCallId: string
    argumentsDelta: string
  }
  'agent:tool-call': {
    messageId: string
    toolCallId: string
    toolName: string
    args: Record<string, unknown>
  }
  'agent:tool-result': {
    messageId: string
    toolCallId: string
    toolName: string
    result: string
    /** 大输出落盘后的 artifact ID，供 UI「查看完整输出」入口使用 */
    artifactId?: string
    /** 截断元数据（共 N 行 / 展示 M 行），与 ToolResult.truncationMeta 对齐 */
    truncationMeta?: ToolTruncationMeta
  }
  'agent:permission-request': {
    messageId: string
    requestId: string
    toolName: string
    args: Record<string, unknown>
    riskLevel: 'low' | 'medium' | 'high'
    reason: string
    commands?: string[]
    /** 本次请求对应的工具卡片 id 列表，渲染层据此把放行卡片内联到消息流（锚点取末尾一张） */
    toolCallIds?: string[]
  }
  'agent:diff-update': {
    messageId: string
    /** live: 工具执行后实时占位信号（无 hunks）；final: 最终数据（含 hunks） */
    phase: 'live' | 'final'
    /**
     * 文件级元数据。
     * phase === 'live' 时 hunks 字段保证为空数组；
     * phase === 'final' 时携带完整 hunks。
     */
    diffs: Array<{ filePath: string; status: DiffEntry['status']; hunks?: DiffEntry['hunks'] }>
    reviews: Record<string, DiffReviewStatus>
  }
  'agent:verification-result': {
    messageId: string
    result: string
  }
  'agent:verification-permission-request': {
    messageId: string
    requestId: string
    command: string
  }
  'agent:verification-permission-cleared': {
    messageId: string
    requestId: string
  }
  'agent:ask-question-request': {
    requestId: string
    questions: AskQuestionItem[]
    /** 可选归属字段（阶段 2）；旧事件可能缺失 */
    sessionId?: string
    messageId?: string
    runId?: string
    interactionId?: string
    version?: number
  }
  'agent:ask-question-resolved': {
    requestId: string
  }
  /** RunCoordinator 权威快照推送 */
  'run:snapshot': {
    snapshot: RunSnapshot
    event: {
      sequence: number
      type: string
      at: number
    }
  }
  'agent:todos-updated': {
    sessionId: string
    todos: TodoItem[]
    view: TodoViewInfo
  }
  'agent:error': {
    messageId: string
    error: string
  }
  'agent:message-end': {
    messageId: string
    /**
     * Phase 3：true 表示本轮 message-end 是由 cancel 触发的（用户主动中断），
     * renderer 据此把消息标记为 interrupted 状态。
     * 正常完成的消息不写此字段。
     */
    interrupted?: boolean
  }
  'agent:thinking-delta': {
    messageId: string
    delta: string
  }
  'agent:usage': {
    messageId: string
    usage: NormalizedUsage
    /** 实际产出 usage 的 provider 档案 id（fallback 后归属新 provider） */
    cacheProfileId: string
  }
  'agent:cache-diagnostic': {
    messageId: string
    diagnostic: {
      cacheBreakDetected: boolean
      reason?: string
      suggestion?: string
      tokenDelta?: number
      firstDiffIndex?: number | null
      firstDiffPart?: string | null
      epochId?: string
      expectedReuseTokens?: number
      actualCacheReadTokens?: number
      prefixDiff?: {
        epochId: string
        firstDiffIndex: number | null
        firstDiffPart: string | null
        previousMessageCount: number
        currentMessageCount: number
        commonPrefixBytes: number
        invalidatedSuffixBytes: number
        estimatedInvalidatedTokens: number
        expectedReuseTokens: number
        expectedMiss: boolean
        actualCacheReadTokens?: number
      }
    }
  }
  'agent:context-breakdown': {
    sessionId: string
    messageId: string
    /** 五类分项 token,均为本轮 LLM 调用实际发送给模型的拆分估算 */
    breakdown: {
      systemPrompt: number
      skills: number
      tools: number
      messages: number
      other: number
    }
    /** 五项合计,与 usage.promptTokens 同口径对账 */
    totalEstimated: number
    /** API 真实回传的 prompt_tokens(若有,无则 0),用于校验估算偏差 */
    promptTokensActual: number
    /** 时间戳,renderer 用来节流或丢弃过期帧 */
    capturedAt: number
    /** 计算时使用的上下文窗口上限(部分场景需要覆盖 store 默认值) */
    contextLimit?: number
  }
  'agent:hook-error': {
    messageId: string
    hookEvent: HookEvent
    error: string
  }
  'agent:recovery-hint': {
    messageId: string
    hint: string
    attempt: number
  }
  'agent:recovery-state': {
    messageId: string
    state: RendererRecoveryState
  }
  'agent:model-switched': {
    messageId: string
    modelId: string
    fallbackIndex: number
    reason: string
  }
  /** 失败 attempt 的临时流式块应回滚，避免与下一次 attempt 文本重复 */
  'agent:attempt-failed': {
    messageId: string
    attemptId: string
    error: string
  }
  'window:maximize-change': {
    isMaximized: boolean
  }
  'skill:changed': {
    skills: SkillSummary[]
  }
  /** 工作区状态变更广播（PRD §5.1）。主进程是唯一写入方。 */
  'workspace:changed': {
    state: WorkspaceState
  }
  'compose:phase-change': {
    runId: string
    /** 发起编排的会话 id；renderer 据此按会话隔离面板 */
    sessionId?: string
    phase: string
  }
  'compose:task-update': {
    runId: string
    sessionId?: string
    tasks: unknown[]
  }
  'compose:ask-user': {
    runId: string
    sessionId?: string
    requestId: string
    question: string
    options: string[]
  }
  'compose:log': {
    runId: string
    sessionId?: string
    message: string
  }
  'compose:state': {
    runId: string
    sessionId?: string
    state: Record<string, unknown>
  }
  /**
   * @deprecated 阶段 6 起不再广播。轮次归属请订阅 `run:snapshot`。
   * 类型保留一版，避免旧 preload 监听方类型报错。
   */
  'agent:turn-state': {
    inProgress: boolean
    sessionId: string | null
  }
  'app:update-downloaded': {
    version: string
  }
}

/** 所有事件 channel 名称 */
export type IpcEventChannel = keyof IpcEvents

/** 事件监听回调类型 */
export type IpcEventCallback<T extends IpcEventChannel> = (data: IpcEvents[T]) => void
