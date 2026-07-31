/**
 * 编排控制器出口。
 *
 * 只导出生命周期入口与查询契约；WorkflowRun 属于内部实现，测试直接 import 子模块。
 */
export { WorkflowOrchestrator } from './WorkflowOrchestrator'
export type {
  ResolveWorkflowDefinition,
  StartWorkflowOptions,
  WorkflowHostDeps,
  WorkflowOrchestratorDeps,
  WorkflowRunOutcome,
  WorkflowRunSnapshot,
  WorkflowRunStatus
} from './types'
