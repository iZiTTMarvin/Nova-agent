/**
 * 请求投影层：将"权威上下文"（context.messages）与"本次模型请求看到的消息"（chatMessages）分离。
 *
 * 三条纪律：
 * 1. 投影结果绝不写回 context.messages——context.messages 永远保留全文，是权威事实。
 * 2. 溢出压缩恢复后必须重新投影（调用方的 continue 路径回到循环顶会重新执行投影；若未来有人把恢复改成就地重试，必须显式重新投影）。
 * 3. 投影是幂等的——对已是占位符的内容再次投影原样返回。
 */
import { createHash } from 'crypto'
import type { ChatMessage } from '../../model/types'

/** 当轮归档阈值：超过此估算 token 的工具结果替换为占位符 */
export const ACTIVE_TOOL_RESULT_MAX_TOKENS = 2048
/** 起始归档轮次（第 0 轮不归档，保留首轮上下文完整） */
export const ACTIVE_PRUNE_MIN_TOOL_ROUND = 1
/** 字符/token 估算系数，与 estimateContextSize 的 JSON 字节 / 4 口径一致 */
const CHARS_PER_TOKEN = 4

/** 占位符 kind 常量 */
export const ARCHIVED_PLACEHOLDER_KIND = 'nova.archived_tool_result'
const ARCHIVED_PLACEHOLDER_VERSION = 1
/** 投影层归档的 artifact toolName 标记（ChatMessage 不携带工具名） */
const ARCHIVE_TOOL_NAME_TAG = '_runtime_archived'

/** 归档占位符结构（序列化为单行 JSON 存入 ChatMessage.content） */
export interface ArchivedToolResultPlaceholder {
  kind: typeof ARCHIVED_PLACEHOLDER_KIND
  v: number
  artifactId: string
  resourceRef: string
  toolCallId: string
  toolName: string
  sha256: string
  originalBytes: number
  originalEstimatedTokens: number
  reason: 'active_current_turn_pruned'
  readInstructions: string
}

/**
 * 判断消息正文是否已是归档占位符。
 * parse 失败一律视为非占位符，绝不抛异常。
 */
export function isArchivedPlaceholder(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return false
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed !== 'object' || parsed === null) return false
    const obj = parsed as Record<string, unknown>
    return obj.kind === ARCHIVED_PLACEHOLDER_KIND
      && obj.v === ARCHIVED_PLACEHOLDER_VERSION
      && typeof obj.resourceRef === 'string'
      && typeof obj.sha256 === 'string'
  } catch {
    return false
  }
}

/** 从 content 中提取纯文本（content 可能是 string 或多模态块数组） */
function asText(content: ChatMessage['content']): string {
  return typeof content === 'string' ? content : ''
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function buildPlaceholder(
  artifactId: string,
  toolCallId: string,
  body: string,
  bodySha256: string
): string {
  const placeholder: ArchivedToolResultPlaceholder = {
    kind: ARCHIVED_PLACEHOLDER_KIND,
    v: ARCHIVED_PLACEHOLDER_VERSION,
    artifactId,
    resourceRef: `artifact://${artifactId}?sha256=${bodySha256}&bytes=${Buffer.byteLength(body, 'utf8')}`,
    toolCallId,
    toolName: ARCHIVE_TOOL_NAME_TAG,
    sha256: bodySha256,
    originalBytes: Buffer.byteLength(body, 'utf8'),
    originalEstimatedTokens: Math.ceil(body.length / CHARS_PER_TOKEN),
    reason: 'active_current_turn_pruned',
    readInstructions: 'This result is archived but still readable. Call archive_read with this ref: operation "inspect" for structure, "search" with keyword to locate content, "read" with offset/limit for a bounded page.'
  }
  return JSON.stringify(placeholder)
}

/** 当轮工具结果归档策略 */
export interface ActiveToolResultPrunePolicy {
  enabled: boolean
  /** 归档阈值（估算 token） */
  maxEstimatedTokens?: number
  /** 起始归档轮次（第 0 轮不改写） */
  minToolRound?: number
}

/** 归档候选：一份待写入 artifact 的工具结果原文 */
export interface ArchiveCandidate {
  toolCallId: string
  toolName: string
  body: string
  /** body 的 sha256，用作缓存键与 lineage 依据 */
  bodySha256: string
}

export interface RequestProjectionInput {
  messages: ChatMessage[]
  toolRound: number
  policy: ActiveToolResultPrunePolicy
  /**
   * 写入 artifact。返回 null 表示写入失败（调用方保留原文并计入诊断）。
   * 契约：实现方不得抛异常，所有失败都必须表达为 null。
   */
  archive: (input: ArchiveCandidate) => Promise<{ artifactId: string } | null>
}

export interface RequestProjectionDiagnostics {
  prunedCount: number
  archiveFailures: number
  estimatedTokensSaved: number
}

export interface RequestProjectionResult {
  messages: ChatMessage[]
  /** 诊断用，不进模型上下文 */
  diagnostics: RequestProjectionDiagnostics
}

const EMPTY_DIAGNOSTICS: RequestProjectionDiagnostics = {
  prunedCount: 0,
  archiveFailures: 0,
  estimatedTokensSaved: 0
}

/** 关闭态策略：门面默认值 */
export const DISABLED_PRUNE_POLICY: ActiveToolResultPrunePolicy = { enabled: false }

export async function projectRequestMessages(
  input: RequestProjectionInput
): Promise<RequestProjectionResult> {
  if (!input.policy.enabled) {
    return { messages: input.messages, diagnostics: EMPTY_DIAGNOSTICS }
  }

  const maxTokens = input.policy.maxEstimatedTokens ?? ACTIVE_TOOL_RESULT_MAX_TOKENS
  const minRound = input.policy.minToolRound ?? ACTIVE_PRUNE_MIN_TOOL_ROUND

  // 第 0 轮不归档，保留首轮上下文完整
  if (input.toolRound < minRound) {
    return { messages: input.messages, diagnostics: EMPTY_DIAGNOSTICS }
  }

  const maxChars = maxTokens * CHARS_PER_TOKEN
  const cache = new Map<string, string>()
  let prunedCount = 0
  let archiveFailures = 0
  let estimatedTokensSaved = 0

  const projected: ChatMessage[] = []

  for (const msg of input.messages) {
    if (msg.role !== 'tool' || !msg.toolCallId) {
      projected.push(msg)
      continue
    }

    const text = asText(msg.content)
    if (!text) {
      projected.push(msg)
      continue
    }

    // 幂等：已是占位符则原样返回
    if (isArchivedPlaceholder(text)) {
      projected.push(msg)
      continue
    }

    // 阈值判定
    if (text.length <= maxChars) {
      projected.push(msg)
      continue
    }

    const bodySha256 = sha256Hex(text)
    const cacheKey = `${msg.toolCallId}:${bodySha256}`

    // 缓存命中则复用占位符
    const cachedPlaceholder = cache.get(cacheKey)
    if (cachedPlaceholder !== undefined) {
      projected.push({ ...msg, content: cachedPlaceholder })
      prunedCount++
      estimatedTokensSaved += Math.ceil((text.length - cachedPlaceholder.length) / CHARS_PER_TOKEN)
      continue
    }

    // 写入 artifact；archive 回调不得抛异常，失败表达为 null（保留原文）
    const archived = await input.archive({
      toolCallId: msg.toolCallId,
      toolName: ARCHIVE_TOOL_NAME_TAG,
      body: text,
      bodySha256
    })

    if (!archived) {
      archiveFailures++
      projected.push(msg)
      continue
    }

    const placeholder = buildPlaceholder(
      archived.artifactId,
      msg.toolCallId,
      text,
      bodySha256
    )
    cache.set(cacheKey, placeholder)
    projected.push({ ...msg, content: placeholder })
    prunedCount++
    estimatedTokensSaved += Math.ceil((text.length - placeholder.length) / CHARS_PER_TOKEN)
  }

  return {
    messages: projected,
    diagnostics: { prunedCount, archiveFailures, estimatedTokensSaved }
  }
}
