/**
 * 工具层类型定义
 * 定义工具的统一接口、执行上下文和返回结构
 */

import type { ToolDefinition } from '../model/types'

/** 工具执行上下文，携带工作区边界和 checkpoint 信息 */
export interface ToolContext {
  /** 工作区根目录的绝对路径，所有路径操作不得越界 */
  workingDir: string
  /** checkpoint 管理器（写入类工具需要通过它做写前备份） */
  checkpointManager?: import('../checkpoints/CheckpointManager').CheckpointManager
}

/** 工具执行结果 */
export interface ToolResult {
  /** 是否执行成功 */
  success: boolean
  /** 工具输出（文本格式，供模型理解） */
  output: string
  /** 错误信息（仅在 success=false 时有值） */
  error?: string
}

/** 工具执行器接口，所有工具必须实现 */
export interface ToolExecutor {
  /** 工具名称，全局唯一 */
  name: string
  /** 工具描述，供模型理解何时使用 */
  description: string
  /** JSON Schema 格式的参数定义，供模型生成调用 */
  parameters: ToolDefinition['parameters']
  /** 执行工具 */
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
}
