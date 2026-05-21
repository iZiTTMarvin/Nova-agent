/**
 * ModelClient 抽象接口
 * 定义模型调用的标准契约，便于测试时 mock 和未来替换模型后端
 */
import type { ChatMessage, ChatEvent, ToolDefinition, ModelClientConfig } from './types'

export interface ModelClient {
  /**
   * 发送消息序列并获取流式响应
   * @param messages 对话上下文
   * @param tools 可选的工具定义列表
   * @returns 流式事件序列
   */
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[]
  ): AsyncIterable<ChatEvent>

  /** 更新模型配置（运行时切换模型） */
  updateConfig(config: ModelClientConfig): void
}
