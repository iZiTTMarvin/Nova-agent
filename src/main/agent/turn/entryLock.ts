/**
 * 会话入口锁的决策。
 *
 * 同一会话同时只允许一个 turn。turn 已被占用时的处理方式取决于占用者：
 * - 编排运行中：拒绝新消息并回一个运行态信号。编排可能跑几十分钟，排队消息会在用户
 *   早已遗忘后才被消费，届时它会被当成一条全新请求处理，所以不能进 steering queue。
 * - 其余情况（默认 / plan 模式）：沿用 steering queue 排队，行为不变。
 *
 * 抽成纯函数是为了让这条互斥规则能被直接断言，而不必驱动整条 SEND_MESSAGE 主链。
 */

export interface ActiveWorkflowRunRef {
  runId: string
  workflow: string
  phase: string
}

export type EntryLockAction =
  /** 入口空闲，继续本 turn */
  | { kind: 'proceed' }
  /** 进 steering queue，当前 turn 终态后自动发起 */
  | { kind: 'steer' }
  /** 编排运行中：拒绝并通知 renderer */
  | { kind: 'workflow_busy'; run: ActiveWorkflowRunRef }

export interface EntryLockInput {
  /** 该会话是否已有占用 turn 的 run */
  turnInProgress: boolean
  /** 该会话运行中的编排；无则为 null */
  activeWorkflowRun: ActiveWorkflowRunRef | null
}

export function resolveEntryLockAction(input: EntryLockInput): EntryLockAction {
  if (!input.turnInProgress) return { kind: 'proceed' }
  if (input.activeWorkflowRun) {
    return { kind: 'workflow_busy', run: input.activeWorkflowRun }
  }
  return { kind: 'steer' }
}
