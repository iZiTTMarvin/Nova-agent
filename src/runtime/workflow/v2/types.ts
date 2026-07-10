/**
 * Workflow v2：step 状态与策略类型
 */
export type StepStatus = 'pending' | 'running' | 'committed' | 'failed'

/** step 重试 / 幂等策略 */
export interface StepPolicy {
  /** 失败是否可重试（resume 时重新执行） */
  retryable?: boolean
  /** 副作用类型：影响 resume 是否安全重跑 */
  sideEffect?: 'none' | 'llm' | 'bash' | 'worktree' | 'integrate' | 'fs' | 'state'
}

export type StepKind =
  | 'agent'
  | 'bash'
  | 'worktree'
  | 'integrate'
  | 'write'
  | 'phase'
  | 'state'
  | 'custom'

export interface StepRecord {
  stepId: string
  kind: StepKind
  inputHash: string
  /** idempotencyKey = runId + stepId + inputHash */
  idempotencyKey: string
  status: StepStatus
  policy: StepPolicy
  /** 已提交的输出（committed 时） */
  output?: unknown
  error?: string
  startedAt?: string
  finishedAt?: string
  /** 依赖的 stepId 列表 */
  deps?: string[]
}

export interface StepDefinition<TInput = unknown, TOutput = unknown> {
  id: string
  kind: StepKind
  policy?: StepPolicy
  deps?: string[]
  /** 计算 inputHash 的材料（会 canonical + sha256） */
  input: TInput
  /** 实际执行；仅在 pending/retryable-failed 时调用 */
  run: (ctx: StepRunContext) => Promise<TOutput>
}

export interface StepRunContext {
  runId: string
  stepId: string
  inputHash: string
  idempotencyKey: string
  signal: AbortSignal
  /** 读取已 committed 依赖的输出 */
  getOutput: <T = unknown>(stepId: string) => T | undefined
}

export interface WorkflowV2Manifest {
  version: 2
  workflowName: string
  scriptSha: string
  runId: string
  createdAt: string
  updatedAt: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  /** 已声明的 step 顺序（稳定 ID） */
  stepIds: string[]
  /** 可选：从该 step 起强制重跑 */
  rerunFromStepId?: string
}

export interface ResumePlan {
  /** 将跳过（已 committed 且不在 rerun 范围） */
  skip: Array<{ stepId: string; kind: StepKind; status: StepStatus }>
  /** 将执行（pending / failed-retryable / rerun 范围） */
  run: Array<{ stepId: string; kind: StepKind; status: StepStatus }>
  /** 不可自动恢复的 failed（非 retryable） */
  blocked: Array<{ stepId: string; kind: StepKind; error?: string }>
}
