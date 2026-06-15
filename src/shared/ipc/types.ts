/**
 * IPC 命令和事件的类型定义
 * 保证 renderer → main 命令和 main → renderer 事件的端到端类型安全
 */
import type { Mode, PermissionDecision, Message, Session, SessionDetail } from '../session'
import type { ModelConfig } from '../config'
import type { DiffEntry, DiffReviewStatus } from '../diff'
import type { NormalizedUsage } from '../../runtime/model/types'
import type { HookEvent } from '../../runtime/agent/types'
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
  SetModeParams,
  RollbackMessageParams
} from '../workspace/types'
import type {
  PermissionRuleDto,
  PermissionListParams,
  PermissionUpsertParams,
  PermissionDeleteParams
} from '../permissions/types'

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
  'select-project': {
    params: void
    result: string | null
  }
  'send-message': {
    params: {
      sessionId: string
      content: string
      images?: Array<{
        fileName: string
        /** base64 data: URI（renderer 端 FileReader.readAsDataURL 编码） */
        data: string
        mimeType: string
      }>
    }
    result: void
  }
  'cancel-execution': {
    params: void
    result: void
  }
  'save-model-config': {
    params: ModelConfig
    result: void
  }
  'load-model-config': {
    params: void
    result: ModelConfig | null
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
    result: {
      diffs: DiffEntry[]
      reviews: Record<string, DiffReviewStatus>
    }
  }
  'reject-file': {
    params: { sessionId: string; messageId: string; filePath: string }
    result: void
  }
  'rollback-message': {
    params: { sessionId: string; messageId: string }
    result: void
  }
  'respond-permission': {
    params: { requestId: string; decision: PermissionDecision }
    result: void
  }
  'respond-verification-permission': {
    params: { requestId: string; granted: boolean }
    result: void
  }
  'load-sessions': {
    params: void
    result: Session[]
  }
  'load-session': {
    params: { sessionId: string }
    result: SessionDetail
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
  'workspace:select-session': {
    params: { sessionId: string }
    result: WorkspaceState
  }
  'workspace:set-mode': {
    params: SetModeParams
    result: WorkspaceState
  }
  'workspace:rollback-message': {
    params: RollbackMessageParams
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
  // ── DiffViewer 批量审阅（PRD §5.3） ──
  'accept-all-files': {
    params: { sessionId: string; messageId: string; filePaths: string[] }
    result: void
  }
  'reject-all-files': {
    params: { sessionId: string; messageId: string; filePaths: string[] }
    result: { restored: string[]; failed: Array<{ filePath: string; error: string }> }
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
  }
  'agent:permission-request': {
    messageId: string
    requestId: string
    toolName: string
    args: Record<string, unknown>
    riskLevel: 'low' | 'medium' | 'high'
    reason: string
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
}

/** 所有事件 channel 名称 */
export type IpcEventChannel = keyof IpcEvents

/** 事件监听回调类型 */
export type IpcEventCallback<T extends IpcEventChannel> = (data: IpcEvents[T]) => void
