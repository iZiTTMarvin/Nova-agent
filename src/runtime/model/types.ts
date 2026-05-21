/**
 * 模型层类型定义
 * 对齐 OpenAI Chat Completions API 的请求/响应结构
 */

// ── 消息格式 ──────────────────────────────────────────────

/** 发送给模型的消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant 消息可携带工具调用 */
  toolCalls?: ChatToolCall[]
  /** tool 消息必须携带 toolCallId */
  toolCallId?: string
}

/** 模型返回的工具调用 */
export interface ChatToolCall {
  id: string
  name: string
  arguments: string
}

// ── 工具 schema ─────────────────────────────────────────

/** 向模型暴露的工具描述 */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema 格式的参数定义 */
  parameters: Record<string, unknown>
}

// ── 模型配置 ─────────────────────────────────────────────

/** 创建 ModelClient 实例所需的配置 */
export interface ModelClientConfig {
  baseUrl: string
  apiKey: string
  modelId: string
}

// ── 流式事件 ─────────────────────────────────────────────

/** 模型产出的流式事件 */
export type ChatEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; toolCall: ChatToolCall }
  | { type: 'message_start' }
  | { type: 'message_end'; finishReason: 'stop' | 'tool_calls' | string }
  | { type: 'error'; error: string }
