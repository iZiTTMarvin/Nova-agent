/**
 * 真实 API 缓存门禁的共享基建。
 *
 * 用 headless 运行时驱动真实 AgentLoop + 真实 OpenAI-compatible 客户端，
 * 以捕获型装饰客户端记录每次请求的用途标记与归一化 usage。
 * 不替换 AgentLoop、StreamProcessor、投影或客户端实现；不新增生产代码后门。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { AgentLoop, EventBus } from '../../src/runtime/agent'
import { agentRoute } from '../../src/runtime/agent/turn'
import { OpenAICompatibleModelClient } from '../../src/runtime/model/OpenAICompatibleModelClient'
import { resolveCacheProfile } from '../../src/runtime/model/cacheProfile'
import { ToolRegistry } from '../../src/runtime/tools/ToolRegistry'
import { readTool } from '../../src/runtime/tools/readTool'
import { lsTool } from '../../src/runtime/tools/lsTool'
import { ArtifactStore } from '../../src/runtime/artifacts/ArtifactStore'
import { PRESET_PROVIDERS } from '../../src/shared/config/llmRegistry'
import type { ModelClient, ChatOptions } from '../../src/runtime/model/ModelClient'
import type {
  ChatEvent,
  ChatMessage,
  ModelClientConfig,
  ToolDefinition
} from '../../src/runtime/model/types'
import type { NormalizedUsage } from '../../src/shared/model/types'
import { PermissionManager } from '../../src/runtime/permissions/PermissionManager'

/** 门禁覆盖的缓存档案：被动前缀 / all-history 回放 / 路由 key / think-tag 各得验证 */
export type LiveProviderId = 'deepseek' | 'glm' | 'kimi' | 'minimax'

interface ProviderDefaults {
  baseUrl: string
  modelId: string
}

function presetDefault(presetId: keyof typeof PRESET_PROVIDERS): ProviderDefaults {
  const preset = PRESET_PROVIDERS[presetId]
  return { baseUrl: preset.baseUrl, modelId: preset.defaultModels[0].modelId }
}

const PROVIDER_DEFAULTS: Record<LiveProviderId, ProviderDefaults> = {
  deepseek: presetDefault('deepseek'),
  glm: presetDefault('glm'),
  minimax: presetDefault('minimax'),
  // kimi 不在预设注册表内：官方端点与默认模型在此登记
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', modelId: 'kimi-k2-0905-preview' }
}

export interface ResolvedLiveProvider {
  id: LiveProviderId
  apiKey: string
  baseUrl: string
  modelId: string
  cacheProfileId: string
}

/**
 * 从环境变量解析 provider 配置；未配置 key 返回 null（调用方跳过，不报错）。
 * 变量命名：LIVE_CACHE_<ID>_API_KEY / _BASE_URL / _MODEL。
 */
export function resolveLiveProvider(id: LiveProviderId): ResolvedLiveProvider | null {
  const prefix = `LIVE_CACHE_${id.toUpperCase()}`
  const apiKey = process.env[`${prefix}_API_KEY`]
  if (!apiKey) return null
  const baseUrl = process.env[`${prefix}_BASE_URL`] ?? PROVIDER_DEFAULTS[id].baseUrl
  const modelId = process.env[`${prefix}_MODEL`] ?? PROVIDER_DEFAULTS[id].modelId
  return {
    id,
    apiKey,
    baseUrl,
    modelId,
    cacheProfileId: resolveCacheProfile(baseUrl, modelId).id
  }
}

/** 单次请求的捕获记录；usage 在流末尾回填 */
export interface CapturedRequest {
  /** 请求到达序号，从 1 开始 */
  index: number
  purpose: 'main' | 'compaction-summary'
  messageCount: number
  usage?: NormalizedUsage
}

/**
 * 捕获型装饰客户端：透传全部事件，仅记录每次 chat 的用途标记与 usage。
 * 暴露 config 供 AgentLoop 门面读取 provider 元数据（与真实客户端同形状）。
 */
export class CapturingModelClient implements ModelClient {
  readonly config: ModelClientConfig
  private readonly inner: OpenAICompatibleModelClient
  private readonly records: CapturedRequest[] = []

  constructor(inner: OpenAICompatibleModelClient, config: ModelClientConfig) {
    this.inner = inner
    this.config = config
  }

  getRequests(): readonly CapturedRequest[] {
    return this.records
  }

  async *chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions
  ): AsyncIterable<ChatEvent> {
    this.records.push({
      index: this.records.length + 1,
      purpose: options?.purpose === 'compaction-summary' ? 'compaction-summary' : 'main',
      messageCount: messages.length
    })
    const record = this.records[this.records.length - 1]
    for await (const event of this.inner.chat(messages, tools, options)) {
      if (event.type === 'usage') record.usage = event.usage
      yield event
    }
  }

  updateConfig(config: ModelClientConfig): void {
    this.inner.updateConfig(config)
  }
}

/** 失败输出：把全部请求的归一化 usage 列成可定位的表格（含哪次请求、哪项指标） */
export function formatRequestsTable(requests: readonly CapturedRequest[]): string {
  const lines = [
    'seq  purpose              messages  promptTokens  cacheRead  uncachedInput'
  ]
  for (const r of requests) {
    lines.push(
      `#${String(r.index).padEnd(4)}`
      + `${r.purpose.padEnd(20)}`
      + `${String(r.messageCount).padEnd(9)}`
      + `${(r.usage ? String(r.usage.promptTokens) : 'n/a').padEnd(13)}`
      + `${(r.usage ? String(r.usage.cacheReadTokens) : 'n/a').padEnd(10)}`
      + `${r.usage ? String(r.usage.uncachedInputTokens) : 'n/a'}`
    )
  }
  return lines.join('\n')
}

/** 创建隔离的临时工作区并写入 fixture 文件 */
export function createGateWorkspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'nova-live-cache-'))
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(dir, relativePath)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
  return dir
}

/**
 * 稳定 system prompt：内容跨轮次逐字节不变（前缀命中的前提），
 * 长度足够跨过 provider 的缓存计费粒度（≥ 数百估算 token）。
 */
export const GATE_SYSTEM_PROMPT = [
  '你是 Nova 的缓存门禁测试助手，运行在一个隔离的临时工作区中。',
  '你的职责是严格按照用户指令执行文件读取任务，并基于读到的内容如实回答。',
  '',
  '执行约束：',
  '- 用户要求读取文件时，使用 read 工具逐个读取指定路径，不要跳过任何一个。',
  '- 不要修改、创建或删除任何文件。',
  '- 回答必须基于文件实际内容，不要猜测。',
  '- 完成全部读取后再给出总结；总结保持简洁。',
  '',
  '背景说明：本会话用于验证服务端前缀缓存的命中行为，对话历史会逐轮增长。',
  '正常情况下每一轮请求都会复用之前的上下文，你无须关心缓存细节，按指令执行即可。'
].join('\n')

export interface RunLiveConversationOptions {
  provider: ResolvedLiveProvider
  workspaceDir: string
  /** 显式上下文窗口；压缩场景用小窗口让阈值在数轮内触发 */
  contextWindow: number
  turns: string[]
  /** 压缩场景前置注入的稳定历史（模拟既有对话，跨轮字节不变） */
  injectedHistory?: ChatMessage[]
  maxToolRounds?: number
}

export interface LiveConversationResult {
  client: CapturingModelClient
  toolCallCount: number
}

/**
 * 用真实 AgentLoop 跑完整对话并返回捕获记录。
 * 工具集为 read + ls（不含 archive_read）：请求投影关闭，前缀稳定性只取决于
 * 消息历史，门禁聚焦「谁破坏了主对话前缀」。
 */
export async function runLiveConversation(
  options: RunLiveConversationOptions
): Promise<LiveConversationResult> {
  const { provider, workspaceDir, contextWindow, turns } = options
  const registry = new ToolRegistry()
  registry.register(readTool)
  registry.register(lsTool)

  const eventBus = new EventBus()
  let toolCallCount = 0
  eventBus.on(event => {
    if (event.type === 'tool_call') toolCallCount++
  })

  const clientConfig: ModelClientConfig = {
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    modelId: provider.modelId,
    cacheProfile: provider.cacheProfileId,
    supportsVision: false
  }
  const inner = new OpenAICompatibleModelClient(clientConfig)
  const client = new CapturingModelClient(inner, clientConfig)

  const loop = new AgentLoop(client, eventBus, {
    systemPrompt: GATE_SYSTEM_PROMPT,
    contextWindow,
    supportsVision: false,
    permissionMode: 'full_access',
    permissionManager: new PermissionManager(),
    maxToolRounds: options.maxToolRounds ?? 12,
    toolExecution: 'parallel',
    maxParallelToolCalls: 4,
    promptCacheKey: randomUUID()
  })
  loop.setToolRegistry(registry)
  loop.setSessionId(randomUUID())
  loop.setArtifactStore(new ArtifactStore(join(workspaceDir, '.nova-gate-sessions')))
  loop.setWorkingDir(workspaceDir)
  loop.setWorkspaceRoot(workspaceDir)
  loop.setMode('default')
  if (options.injectedHistory) {
    loop.injectHistory(options.injectedHistory)
  }

  try {
    for (const [turnIndex, text] of turns.entries()) {
      const outcome = await loop.sendMessage(text, agentRoute())
      if (outcome.status === 'failed') {
        throw new Error(`第 ${turnIndex + 1} 轮失败: ${outcome.error.message}`)
      }
      if (outcome.status === 'cancelled') {
        throw new Error(`第 ${turnIndex + 1} 轮被取消`)
      }
    }
  } finally {
    loop.dispose()
  }

  return { client, toolCallCount }
}
