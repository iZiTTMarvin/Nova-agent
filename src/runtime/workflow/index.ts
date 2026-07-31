/**
 * 编排运行时唯一对外出口。
 *
 * 白名单原则：只导出跨层消费者真正需要的符号。
 * effects/ scheduling/ state/ 属于内部实现，调用方与测试直接 import 子模块，
 * 不从本 barrel 再导出 —— 避免 barrel 退化成绕过分层边界的通道。
 */

// 生命周期
export {
  runWorkflow,
  cancelWorkflow,
  getWorkflowStatus,
  listWorkflows,
  resolveWorkflowAskUser
} from './runtime'

// run 状态读取（compose IPC 消费）
export { readComposeState } from './state/runState'

// resume 检视（compose IPC 消费）
export { inspectComposeResume, getComposeV2Manifest } from './v2'

// 跨层契约类型
export type {
  RunWorkflowOptions,
  WorkflowRuntimeDeps,
  RunOutcome,
  WorkflowStatus,
  ComposeState,
  ComposeTask,
  ComposeTaskFailure,
  ComposeFailureReason,
  ComposeReview,
  AskUserResolver
} from './types'

export type { ResumePlan, WorkflowV2Manifest } from './v2/types'
