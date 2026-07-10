/**
 * RunCoordinator 共享类型
 *
 * 权威运行快照：主进程是唯一事实源；Renderer 只消费 snapshot + 带 sequence 的事件。
 */

/** Run 种类 */
export type RunKind = 'agent' | 'compose'

/**
 * Run 状态机（允许的主要转换）：
 * queued → running
 * running → waiting_user | retrying | cancelling | completed | failed
 * waiting_user → running | cancelling | interrupted
 * retrying → running | cancelling | failed
 * cancelling → cancelled | failed
 * process_exit → interrupted
 * interrupted → resuming → running
 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'retrying'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'resuming'

/** 硬终态：不可再转换（interrupted 可 → resuming，故单独处理） */
export const HARD_TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'completed',
  'failed',
  'cancelled'
])

/** 含 interrupted 的广义终态（进程视角已结束） */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  ...HARD_TERMINAL_RUN_STATUSES,
  'interrupted'
])

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

export function isHardTerminalRunStatus(status: RunStatus): boolean {
  return HARD_TERMINAL_RUN_STATUSES.has(status)
}

/** Interaction 类型 */
export type InteractionType =
  | 'permission'
  | 'askQuestion'
  | 'composeAskUser'
  | 'verification'

/** Interaction 生命周期状态 */
export type InteractionStatus =
  | 'pending'
  | 'submitting'
  | 'answered'
  | 'dismissed'
  | 'cancelled'

/** 工具调用在 turn 内的提交阶段（对账用） */
export type ToolCommitPhase =
  | 'prepared'
  | 'executing'
  | 'committed'
  | 'failed'

/** 当前模型 attempt 摘要（投影到 snapshot） */
export interface RunAttemptInfo {
  attemptId: string
  providerAttempt: number
  totalAttempts: number
  modelId?: string
}

/** 进度摘要（可选，供 UI 文案） */
export interface RunProgress {
  /** 人类可读短文案，如「等待你的授权」 */
  label?: string
  /** 已完成工具数 / 轮次等粗粒度计数 */
  toolRound?: number
  /** 额外键值，不放敏感内容 */
  extras?: Record<string, string | number | boolean>
}

/** 挂起交互（持久化到 RunStore） */
export interface PendingInteraction {
  interactionId: string
  runId: string
  sessionId: string
  messageId: string
  type: InteractionType
  status: InteractionStatus
  /** 创建时间 */
  createdAt: number
  /** 可选过期策略时间戳；普通 ask/permission 默认不设（禁止一律自动 timeout） */
  expiresAt?: number
  /** 类型相关载荷（权限参数、问题列表等）；不含密钥 */
  payload: Record<string, unknown>
  /** 乐观并发版本：每次状态变更 +1，回答命令需携带期望 version */
  version: number
}

/** 工具调用对账记录 */
export interface ToolCommitRecord {
  toolCallId: string
  toolName: string
  phase: ToolCommitPhase
  /** 是否声明为幂等（非幂等工具中断后不自动重放） */
  idempotent: boolean
  updatedAt: number
  /** 关联 checkpoint / 文件副作用时可选 */
  checkpointRef?: string
}

/**
 * 执行中 assistant 草稿：工具边界的唯一事实源。
 * 终态 finalize 后写入 SessionStore，再从 snapshot 清除。
 */
export interface TurnDraft {
  messageId: string
  attemptId: string
  /** 有序消息块（与 MessageBlock 同构的可序列化结构） */
  blocks: Array<Record<string, unknown>>
  /** 是否已幂等写入 SessionStore */
  finalized: boolean
  updatedAt: number
}

/** Interaction 命令回执（跨进程幂等） */
export interface InteractionCommandAck {
  commandId: string
  interactionId: string
  at: number
  /** 精简结果：ok + code，完整 interaction 可从 pendingInteractions 重建 */
  ok: boolean
  code?: string
  message?: string
}

/** 终态 hook outbox 状态：无 handler / 失败时保持 pending，不得假标 delivered */
export type TerminalOutboxStatus = 'pending' | 'delivering' | 'delivered' | 'failed'

/** 终态 hook 持久化 outbox 条目 */
export interface TerminalOutboxEntry {
  key: string
  runId: string
  terminalTransitionId: string
  hookName: string
  status: TerminalOutboxStatus
  at: number
  /** handler 失败时的错误摘要；可重试 */
  lastError?: string
  /** handler 去重用的稳定幂等键 */
  idempotencyKey?: string
}

/** 权威 Run 快照 */
export interface RunSnapshot {
  runId: string
  kind: RunKind
  workspaceId: string
  sessionId: string
  messageId: string
  status: RunStatus
  /** 单调递增事件序号；丢事件后用 snapshot 自愈 */
  sequence: number
  pendingInteractions: PendingInteraction[]
  currentAttempt: RunAttemptInfo | null
  progress: RunProgress | null
  lastHeartbeatAt: number
  createdAt: number
  updatedAt: number
  /** 终态原因（取消 / 失败文案等） */
  terminalReason?: string
  /** 本轮工具对账（T2-5） */
  toolCommits?: ToolCommitRecord[]
  /** turn_started 是否已原子落盘 */
  turnStartedAt?: number
  /** 终态提交去重 id（terminalTransitionId） */
  terminalTransitionId?: string
  /** 执行中消息草稿（工具边界 fsync） */
  turnDraft?: TurnDraft | null
  /** 已处理的 interaction command 回执（跨重启幂等） */
  commandAcks?: InteractionCommandAck[]
  /** 终态 hook durable outbox */
  terminalOutbox?: TerminalOutboxEntry[]
  /**
   * 当前执行 generation（权威 fencing）。
   * 副作用入口必须校验 isExecutionCurrent(runId, generation)；
   * grace 超时 / 强制中断后递增或清零，使旧 continuation 失效。
   */
  executionGeneration?: number
}

/** append-only 事件（落盘 events.jsonl） */
export interface RunEventRecord {
  sequence: number
  runId: string
  type: string
  at: number
  payload?: Record<string, unknown>
}

/** 启动 Run 的参数 */
export interface StartRunParams {
  runId?: string
  kind: RunKind
  workspaceId: string
  sessionId: string
  messageId?: string
}

/** 终态提交参数 */
export interface CommitTerminalParams {
  runId: string
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  reason?: string
  /** 外部传入的 transition id；缺省由 coordinator 生成 */
  terminalTransitionId?: string
}

/** Interaction 回答命令（exactly-once） */
export interface InteractionAnswerCommand {
  interactionId: string
  /** 客户端唯一命令 id，主进程幂等去重 */
  commandId: string
  /** 期望的 interaction.version；不匹配则拒绝 */
  expectedVersion: number
  /** answered / dismissed */
  outcome: 'answered' | 'dismissed'
  /** 类型相关答案载荷 */
  payload?: Record<string, unknown>
}

/** 回答命令结果 */
export type InteractionAnswerResult =
  | { ok: true; interaction: PendingInteraction; snapshot: RunSnapshot }
  | {
      ok: false
      code: 'already_answered' | 'run_ended' | 'not_found' | 'version_mismatch' | 'duplicate_command'
      message: string
      snapshot?: RunSnapshot
    }

/** 允许的状态转换表 */
export const RUN_STATUS_TRANSITIONS: Readonly<Record<RunStatus, ReadonlyArray<RunStatus>>> = {
  queued: ['running', 'cancelling', 'interrupted'],
  running: ['waiting_user', 'retrying', 'cancelling', 'completed', 'failed', 'interrupted'],
  waiting_user: ['running', 'cancelling', 'interrupted'],
  retrying: ['running', 'cancelling', 'failed', 'interrupted'],
  cancelling: ['cancelled', 'failed', 'interrupted'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: ['resuming'],
  resuming: ['running', 'cancelling', 'failed', 'interrupted']
}
