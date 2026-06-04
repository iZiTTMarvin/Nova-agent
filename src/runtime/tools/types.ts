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
  /** 取消信号，用户点击取消时触发，bashTool 等长时间运行工具应监听此信号终止执行 */
  abortSignal?: AbortSignal
  /** 当前模型是否支持图片输入（vision），用于 readTool 决定是否发送图片 */
  supportsVision?: boolean
}

/** 图片内容块，用于多模态工具结果（如 readTool 读取图片） */
export interface ImageContent {
  /** base64 编码的图片数据 */
  data: string
  /** 图片 MIME 类型（image/jpeg、image/png、image/gif、image/webp） */
  mimeType: string
}

/** 工具执行结果 */
export interface ToolResult {
  /** 是否执行成功 */
  success: boolean
  /** 工具输出（文本格式，供模型理解） */
  output: string
  /** 错误信息（仅在 success=false 时有值） */
  error?: string
  /**
   * 图片内容列表（可选）。
   * 当工具返回图片时，output 为文字说明，images 为 base64 编码的图片数据。
   * AgentLoop 会将 output + images 组合为多模态 content 数组发送给模型。
   */
  images?: ImageContent[]
}

/** 工具执行器接口，所有工具必须实现 */
export interface ToolExecutor {
  /** 工具名称，全局唯一 */
  name: string
  /** 工具描述，供模型理解用途 */
  description: string
  /** JSON Schema 格式的入参定义，供模型生成调用 */
  parameters: ToolDefinition['parameters']
  /** 输出最大字符数，超出后由 AgentLoop 通过 TruncationPipeline 截断。未设置则不限制 */
  maxResultSizeChars?: number
  /** 执行工具 */
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
}
