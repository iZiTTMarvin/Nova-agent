/**
 * 模型层类型定义
 * 对齐 OpenAI Chat Completions API 的请求/响应结构
 */

// ── 消息格式 ──────────────────────────────────────────────

/**
 * 多模态内容块。
 * OpenAI Chat Completions API 的 content 字段既支持纯字符串，
 * 也支持由 text 和 image_url 块组成的数组。
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }

/** 从 content（string 或 ContentBlock 数组）中提取纯文本 */
export function extractTextFromContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** 发送给模型的消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[]
  /** assistant 消息可携带工具调用 */
  toolCalls?: ChatToolCall[]
  /** tool 消息必须携带 toolCallId */
  toolCallId?: string
  /**
   * 内部消息标记（参考 OpenClacky 的 system_injected 机制）
   * 标记为 internal 的消息：
   * - 不被缓存标记选择器标记（不注入 cache_control）
   * - 默认不会发送给 API；但受控内部调用（如上下文压缩）可显式放行正文
   * - 无论是否放行正文，internal 字段本身都会在序列化时被剥离
   * 适用场景：压缩指令、运行时临时提示等动态信息
   */
  internal?: boolean
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
  /** 缓存策略，默认 'auto'（前缀稳定即自动命中） */
  cacheStrategy?: 'auto' | 'anthropic'
}

// ── Token 用量 ────────────────────────────────────────────

/**
 * 归一化后的 token 用量统计
 * 统一 OpenAI / DeepSeek / Anthropic 三种 provider 的缓存字段差异
 */
export interface NormalizedUsage {
  promptTokens: number
  completionTokens: number
  /** 从缓存读取的 token 数（命中缓存的部分） */
  cachedTokens: number
  /** 写入缓存的 token 数（创建缓存的部分，仅 Anthropic 类 provider 有值） */
  cacheWriteTokens: number
}

// ── 流式事件 ─────────────────────────────────────────────

/** 模型产出的流式事件 */
export type ChatEvent =
  | { type: 'thinking_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; index: number }
  | { type: 'tool_call_delta'; toolCallId: string; argumentsDelta: string }
  | { type: 'tool_call'; toolCall: ChatToolCall }
  | { type: 'message_start' }
  | { type: 'message_end'; finishReason: 'stop' | 'tool_calls' | string }
  | { type: 'usage'; usage: NormalizedUsage }
  | { type: 'error'; error: string }
  | { type: 'context_overflow'; rawError: string }
  | { type: 'cancelled' }
