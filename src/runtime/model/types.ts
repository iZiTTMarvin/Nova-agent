/**
 * 模型层类型定义
 * 对齐 OpenAI Chat Completions API 的请求/响应结构
 */

import type { ToolTruncationMeta } from '../../shared/tools/types'
import type { NormalizedUsage } from '../../shared/model/types'
import type { CacheStrategy, CacheProfileId } from '../../shared/config/types'

export type { NormalizedUsage }

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
   * 大输出 artifact 指针（role: 'tool' 时可选）。
   * 与 ToolResult.artifactId 对齐，便于会话重启后 read artifact:// 续读。
   */
  artifactId?: string
  /** 大输出截断元数据，与 ToolResult.truncationMeta 对齐 */
  truncationMeta?: ToolTruncationMeta
  /**
   * 内部消息标记（参考 OpenClacky 的 system_injected 机制）
   * 标记为 internal 的消息：
   * - 不被缓存标记选择器标记（不注入 cache_control）
   * - 默认不会发送给 API；但受控内部调用（如上下文压缩）可显式放行正文
   * - 无论是否放行正文，internal 字段本身都会在序列化时被剥离
   * 适用场景：压缩指令、运行时临时提示等动态信息
   */
  internal?: boolean
  /**
   * 排除出缓存断点选择，但仍发送给模型（用于每轮变化的尾部注入，如记忆 L2）。
   * 与 internal 不同：internal 默认不发送；skipCacheMarker 始终发送，只是不参与 cache_control 标记。
   */
  skipCacheMarker?: boolean
  /**
   * 运行时字段：本子轮聚合的 reasoning / thinking 正文，供模型历史回传用。
   * 不写入 renderer / UI blocks / 导出文件 / SessionMessage.content（约束 4）。
   */
  reasoningContent?: string
  /**
   * 产生 reasoningContent 的缓存档案 ID；与 ThinkingBlock.providerId 对齐。
   * 跨档案回放时由序列化门控剥离；缺省视为与当前档案兼容。
   */
  reasoningProviderId?: string
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
  /**
   * 缓存策略（兼容字段）。唯一类型来源：shared/config/types.CacheStrategy。
   * 与 cacheProfile 一并交给 resolveCacheProfile；缺省时按 URL/modelId 自动判定。
   */
  cacheStrategy?: CacheStrategy
  /**
   * 缓存档案覆盖。唯一类型来源：shared/config/types.CacheProfileId。
   * 'auto'/缺省时走 resolveCacheProfile 自动判定。
   */
  cacheProfile?: 'auto' | CacheProfileId
  /**
   * 思考强度覆盖。缺省或 'auto'：非 GLM 不发送；GLM 仍注入保留式思考。
   * 'low'/'medium'/'high' 按 provider 方言注入 reasoning_effort（GLM 额外带 thinking 对象）。
   */
  reasoningEffort?: 'auto' | 'low' | 'medium' | 'high'
  /**
   * 是否支持图片输入。未设置时按优先级查注册表→字符串兜底→默认 false（见 resolveSupportsVision）。
   * 用于 API 层视觉投影（剥离 / provider 适配），与 UI 门控共用同一语义。
   */
  supportsVision?: boolean
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
  /**
   * 网关拒绝 prompt_cache_key 后，本 client 已剥离该字段并重试一次。
   * StreamProcessor 转为 cache_diagnostic，不触发 fallback / 工具重跑。
   * @deprecated 新路径统一走 capability_downgrade；保留以兼容旧测试/诊断。
   */
  | { type: 'prompt_cache_key_stripped'; detail: string }
  /**
   * 网关拒绝某请求参数后，本 client 已记录会话级禁用并剥离重试。
   * StreamProcessor 调用 bumpEpoch('provider_capability_downgrade')。
   */
  | {
      type: 'capability_downgrade'
      capability: 'prompt_cache_key' | 'reasoning_content' | 'clear_thinking'
      detail: string
    }
  /**
   * 最终请求体语义快照（仅哈希，无明文）。StreamProcessor 写入 CacheDiagnostics。
   */
  | { type: 'wire_snapshot'; snapshot: import('./requestFingerprint').WireSnapshot }
