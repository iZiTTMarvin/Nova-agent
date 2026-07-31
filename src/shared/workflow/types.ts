/**
 * 编排（XForge）跨层共享契约。
 *
 * 进度语义与 run 状态被 runtime（事件产出）、main（IPC 转发）、renderer（进度块渲染）
 * 三层共用，因此类型只能有这一处来源；任何一层都不得再复制一份近似定义。
 */

/**
 * 进度语义。
 * started / completed / failed 描述阶段本身；task_* 与 batch_* 描述并行 implement 的批次进展。
 */
export type WorkflowProgressStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'task_started'
  | 'task_complete'
  | 'task_failed'
  | 'batch_started'
  | 'batch_merge'
  | 'info'

/** 进度块的可选补充信息；字段全部可缺省，renderer 只做展示不做逻辑分支 */
export interface WorkflowProgressDetail {
  taskId?: string
  taskName?: string
  batchIndex?: number
  batchSize?: number
  message?: string
}

/** run 状态机取值：无暂停态，askQuestion 阻塞期间仍是 running */
export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'
