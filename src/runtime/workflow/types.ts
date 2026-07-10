/**
 * 编排运行时公共类型
 * 脚本侧只见纯数据；host 侧通过依赖注入接入 AgentLoop / 工具 / 权限
 */
import type { EventBus } from '../agent/EventBus'
import type { ModelClient } from '../model/ModelClient'
import type { CheckpointManager } from '../checkpoints/CheckpointManager'
import type { Mode } from '../../shared/session/types'
import type { ToolExecutor } from '../tools/types'
import type { SubAgentPermissionBridge } from '../tools/subAgentBridge'
import type { SkillManifest } from '../skills/types'

/** 单次 agent() 调用选项（脚本侧传入） */
export interface AgentHookOpts {
  /** 强制 JSON schema 结构化返回；命中后 agent() 解析为 object */
  schema?: Record<string, unknown>
  /** worktree 隔离（阶段 B 生效；阶段 A 忽略） */
  isolation?: 'worktree' | 'none'
  /**
   * 在已有目录跑子 agent（复用 impl 创建的 worktree，供 verify/debug）。
   * 优先于 isolation:'worktree'；不新建 worktree、不写 journal。
   */
  directory?: string
  /** 指定编排 skill 正文作为子 agent 角色（映射为 journal 的 agentType） */
  skill?: string
  /** 单次 agent 超时，默认 10 分钟 */
  timeoutMs?: number
  /** 仅展示用，不参与 journal hash */
  label?: string
  /** 工具白名单，不参与 journal hash */
  tools?: string[]
  /** 覆盖默认模型 id，参与 journal hash */
  model?: string
  /** 当前 phase 名，参与 journal hash；缺省取 runtime 当前 phase */
  phase?: string
}

/** runWorkflow 入参 */
export interface RunWorkflowOptions {
  /** 内置脚本名，或内联脚本全文（含 export const meta） */
  script: string
  /** 注入脚本全局 args */
  args?: unknown
  /** 依赖注入（与 createTaskTool 同构） */
  deps: WorkflowRuntimeDeps
  /** 指定 runId；缺省自动生成 YYYY-MM-DD-HHmmss */
  runId?: string
  /** 整脚本墙钟预算，默认 12h */
  deadlineMs?: number
  /** 阶段 B：resume 已有 run */
  resume?: boolean
  /** 阶段 B：per-run 并发上限 */
  maxConcurrentAgents?: number
  /**
   * 外部取消信号（如 AgentLoop 的 abortController）。
   * 触发后等价于 cancelWorkflow(runId)：解除 askUser 挂起、终止子 agent、
   * run 以 cancelled 终态收尾。没有它「停止按钮」无法穿透到编排 run。
   */
  abortSignal?: AbortSignal
  /**
   * 脚本源变化时的 resume 策略。
   * - reject（resume 默认）：拒绝恢复，抛 ScriptShaMismatchError
   * - migrate：显式清空 journal 后继续
   * - clear：静默清空（仅非 resume / 兼容路径）
   */
  scriptShaMismatch?: 'reject' | 'migrate' | 'clear'
  /**
   * 引擎版本：v1=沙箱脚本+journal；v2=step graph（内置 br-full-dev 优先）。
   * 缺省：内置 br-full-dev 走 v2，其余 v1。
   */
  engine?: 'v1' | 'v2'
  /** v2：从指定 step 之后重跑（含该 step） */
  rerunFromStepId?: string
}

/** 运行时依赖：禁止把 AgentLoop 引用直接塞进沙箱 */
export interface WorkflowRuntimeDeps {
  modelClient: ModelClient
  parentEventBus: EventBus
  resolveTool: (name: string) => ToolExecutor | undefined
  workspaceRoot: string
  permissionBridge?: SubAgentPermissionBridge
  /** 按名取 skill（agent({ skill }) 用） */
  resolveSkill?: (name: string) => SkillManifest | undefined
  checkpointManager?: CheckpointManager
  contextWindow?: number
  supportsVision?: boolean
  /**
   * 子 agent 行为模式。
   * 编排 run 内默认 'compose'（固定 auto 权限语义，危险命令仍拦）。
   */
  mode?: Mode
  sessionId?: string
  /**
   * 覆盖 askUser 默认阻塞等待（单测注入 resolver；无 UI 时也可自动应答）。
   * 未提供时 emit workflow_ask_user，由 resolveWorkflowAskUser 解除阻塞。
   */
  askUserResolver?: AskUserResolver
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export type RunOutcome =
  | { status: 'completed'; runId: string; result: unknown }
  | { status: 'failed'; runId: string; error: string }
  | { status: 'cancelled'; runId: string }

/** 对外可查询的运行摘要（不含 AbortController 等内部句柄） */
export interface WorkflowStatus {
  runId: string
  scriptName: string
  status: RunStatus
  phase?: string
  startedAt: string
  updatedAt: string
  error?: string
}

/** 编排阶段键（state.phase.current） */
export type ComposePhaseKey = 'explore' | 'plan' | 'execute' | 'review' | 'ship'

/** 任务状态 */
export type ComposeTaskStatus = 'pending' | 'in_progress' | 'done' | 'skipped' | 'failed'

/** 任务体量 */
export type ComposeTaskSize = 'XS' | 'S' | 'M' | 'L' | 'XL'

/**
 * 任务失败原因枚举。
 * verify_failed_3x：验收连续 3 次失败被跳过
 * debug_unresolved：br-debug 内层重试未解决
 * dependency_missing：依赖任务被跳过，本任务无法执行
 * test_timeout：验收命令超时
 * user_aborted：用户中途停止
 * agent_failed：实现/子 agent 返回空或异常
 */
export type ComposeFailureReason =
  | 'verify_failed_3x'
  | 'debug_unresolved'
  | 'dependency_missing'
  | 'test_timeout'
  | 'user_aborted'
  | 'agent_failed'

export interface ComposeTaskFailure {
  reason: ComposeFailureReason
  summary: string
  evidence?: string
  root_cause_guess?: string
  tried?: string[]
  next_steps?: string[]
}

export interface ComposeTaskVerify {
  pass: number
  fail: number
  evidence?: string
}

export interface ComposeTask {
  id: string
  title: string
  status: ComposeTaskStatus
  size?: ComposeTaskSize
  /** 依赖的任务 id 列表 */
  deps?: string[]
  /** 验收标准（文本或命令描述） */
  verifyCriteria?: string | string[]
  attempts?: number
  verify?: ComposeTaskVerify
  failure?: ComposeTaskFailure
  started_at?: string
  finished_at?: string
}

export interface ComposeCheckResult {
  status: 'pass' | 'fail' | 'skip'
  evidence?: string
}

export interface ComposeReviewIssue {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'nit'
  file?: string
  line?: number
  summary: string
  suggestion?: string
}

export interface ComposeReview {
  verdict: 'pass' | 'conditional' | 'block'
  critical_count: number
  high_count: number
  issues: ComposeReviewIssue[]
}

export interface ComposeAutoDecision {
  phase: string
  decision: string
  reason: string
  auto: boolean
}

export interface ComposeStats {
  total: number
  done: number
  skipped: number
  failed: number
}

/** askUser 请求载荷（脚本侧传入） */
export interface AskUserRequest {
  question: string
  options: string[]
}

/**
 * `.nova/compose/state.json` 完整结构。
 * 渲染进度面板与脚本 resume 诊断共用此 schema。
 */
export interface ComposeState {
  run: {
    id: string
    command: string
    script: string
    started_at: string
    updated_at: string
    status: RunStatus
    /** 发起编排的会话 id；进度面板据此只在所属会话中展示 */
    session_id?: string
  }
  phase?: {
    current: string
    label: string
    entered_at: string
  }
  artifacts?: {
    spec?: string
    plan?: string
    report?: string
    [key: string]: string | undefined
  }
  tasks?: ComposeTask[]
  global_check?: {
    test?: ComposeCheckResult
    build?: ComposeCheckResult
    lint?: ComposeCheckResult
  }
  auto_decisions?: ComposeAutoDecision[]
  review?: ComposeReview
  stats?: ComposeStats
}

/** 测试或宿主注入：覆盖默认的 askUser 阻塞等待 */
export type AskUserResolver = (req: {
  runId: string
  requestId: string
  question: string
  options: string[]
}) => Promise<string>

export type HostFn = (...args: unknown[]) => unknown | Promise<unknown>

export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: { title: string; detail?: string }[]
  model?: string
}
