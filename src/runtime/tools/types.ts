/**
 * 工具层类型定义
 * 定义工具的统一接口、执行上下文和返回结构
 */

import type { ToolDefinition } from '../model/types'
import type { SessionStore } from '../sessions/SessionStore'
import type { EventBus } from '../agent/EventBus'
import type { ReadState } from './editTool'
import type { AskQuestionItem, AskQuestionAnswer } from '../../shared/askQuestion/types'

/** 工具执行模式：并发安全工具可以进入并发批次，顺序工具必须独占执行 */
export type ToolExecutionMode = 'parallel' | 'sequential'

/** 工具执行上下文，携带工作区边界和 checkpoint 信息 */
export interface ToolContext {
  /** 工作区根目录的绝对路径，所有路径操作不得越界 */
  workingDir: string
  /**
   * 文件读取状态（read state）：记录"模型已 read 过哪些文件以及当时的内容/mtime"。
   * edit / write 工具的"先读后改"校验依赖此状态。
   *
   * 每个 AgentLoop 实例持有独立的 readState，由 toolBatchExecutor 注入。
   * 主 agent 与 sub agent 之间通过 clone 实现隔离，避免 sub agent 读过的文件
   * 污染主 agent 的校验逻辑（I1）。
   */
  readState: ReadState
  /** checkpoint 管理器（写入类工具需要通过它做写前备份） */
  checkpointManager?: import('../checkpoints/CheckpointManager').CheckpointManager
  /** 取消信号，用户点击取消时触发，bashTool 等长时间运行工具应监听此信号终止执行 */
  abortSignal?: AbortSignal
  /** 当前模型是否支持图片输入（vision），用于 readTool 决定是否发送图片 */
  supportsVision?: boolean
  /**
   * 会话级状态存储（可选）。
   * 仅 todo_write 等需要把状态外化到会话的工具使用；其他工具拿不到也无所谓。
   * 不存在时工具走降级路径，不影响主循环。
   */
  sessionStore?: SessionStore
  /** 当前会话 ID，与 sessionStore 配套使用 */
  sessionId?: string
  /**
   * 事件总线（可选）。提供工具向 main → renderer 链路发送自定义事件的能力。
   * 当前只 todo_write 使用，emit 'todos_updated' 触发 renderer store 更新。
   */
  eventBus?: EventBus
  /**
   * 自定义 shell 可执行路径（可选）。
   * 仅为 bash 工具使用：覆盖默认的 Shell 发现（pwsh / powershell / Git Bash / cmd）。
   * 路径不存在时 bash 工具会直接报错。
   */
  shellPath?: string
  /**
   * 需要注入到 PATH 前面的目录列表（可选）。
   * 仅为 bash 工具使用：让项目内的本地工具（node_modules/.bin、vendor 等）优先可用。
   * 仅绝对路径会被处理；空数组 / 仅含相对路径的输入会被忽略。
   */
  binDirs?: string[]
  /**
   * 会话级 artifact 存储（可选）。
   * bash / grep / read 在大输出时写入 artifact 目录，上下文只保留截断块 + 指针。
   */
  artifactStore?: import('../artifacts/ArtifactStore').ArtifactStore
  /**
   * askQuestion 阻塞回调（可选）。
   *
   * 注入路径（与 eventBus / readState 同一条透传链，不是在 agentHandler 直接拼 ToolContext）：
   *   agentHandler（setAskQuestionHandler，闭包捕获本次 eventBus + pendingAskQuestions）
   *     → AgentLoop（实例字段 askQuestionHandler）
   *       → executeBatch 的 options.askQuestion
   *         → toolBatchExecutor.buildToolContext 注入到 ToolContext
   *
   * 工具调用它发起一次提问请求，返回 Promise，resolve 时拿到用户答案。
   * 回调内部负责：创建 Promise → 存 resolve 到模块级 pendingAskQuestions → emit 事件到 renderer → IPC 回复时 resolve。
   * 不存在时工具降级为 no-op（不阻塞）：主 agent 正常注入；子 agent（task / skill fork）未注入会走降级跳过。
   */
  askQuestion?: (requestId: string, questions: AskQuestionItem[]) => Promise<AskQuestionAnswer[]>
  /**
   * 额外允许读取的根目录（绝对路径），当前唯一来源是「本会话已触发的 skill 目录」。
   * 只对只读工具（read/ls/grep/find）生效；edit/write 不消费此字段。
   */
  extraAllowedRoots?: string[]
}

/** 图片内容块，用于多模态工具结果（如 readTool 读取图片） */
export interface ImageContent {
  /** base64 编码的图片数据 */
  data: string
  /** 图片 MIME 类型（image/jpeg、image/png、image/gif、image/webp） */
  mimeType: string
}

/** 大输出截断元数据（工具 / 事件 / 持久化共用） */
export interface ToolTruncationMeta {
  totalBytes: number
  totalLines: number
  shownLines?: number
  truncated: boolean
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
  /**
   * 大输出落盘后的会话内 artifact ID。
   * 模型上下文只保留截断文本 + artifact:// 指针；全文可通过 read artifact:// 续读。
   */
  artifactId?: string
  /** 截断元数据：总行数/字节数、展示行数等，供 UI 与持久化使用 */
  truncationMeta?: ToolTruncationMeta
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
  /** 工具默认执行模式。未声明时视为 sequential。 */
  executionMode?: ToolExecutionMode
  /**
   * 判断当前入参和上下文是否允许并发执行。
   * 未声明或抛错时一律视为不安全，避免误把有副作用的工具放进并发批次。
   */
  isConcurrencySafe?: (args: Record<string, unknown>, context: ToolContext) => boolean
  /** 执行工具 */
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
}
