/**
 * workflow 定义契约。
 *
 * definition 只依赖 HostFns：它不知道自己被谁启动、run 状态存在哪里，
 * 也无权操控自己的生命周期（本目录不得 import orchestrator/）。
 * 阶段推进写在 run() 的普通控制流里，因此不需要额外的 step graph 或暂停态。
 */
import type { HostFns } from '../host'

export type { PlanTask, WorkflowPlan } from '../types'

/** 单次执行交给 definition 的全部输入 */
export interface WorkflowRunContext {
  /** 宿主能力，definition 的唯一依赖面 */
  host: HostFns
  /** 用户原始请求文本 */
  request: string
  /** 起始阶段名，必须是 definition.stages 中的一项 */
  startStage: string
  /** 调用方注入的额外上下文（如已有 plan），definition 自行按需读取 */
  injectedContext: Record<string, unknown>
  /** 本 run 的取消信号；与 TaskScope 同源 */
  abortSignal: AbortSignal
  /** true 时阶段 agent 不携带 askQuestion，决策点自然跳过 */
  autoMode: boolean
}

/**
 * definition 的返回值。
 * 失败用 status:'failed' 表达而不是抛错 —— 阶段内部的 never-throw 契约
 * 一直延伸到 definition 边界，orchestrator 只在真正的编程错误时才看到异常。
 */
export type WorkflowResult =
  | { status: 'completed'; summary?: string; result?: unknown }
  | { status: 'failed'; reason: string }

export interface WorkflowDefinition {
  /** 唯一标识，同时是 start_workflow 工具的入参取值 */
  name: string
  /** 人类可读描述，供路由上下文注入 system prompt */
  description: string
  /** 路由参考信号 */
  matchHints: string[]
  /** 可能的起始阶段列表 */
  stages: string[]
  run(ctx: WorkflowRunContext): Promise<WorkflowResult>
}
