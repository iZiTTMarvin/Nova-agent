/**
 * 请求投影层：将"权威上下文"（context.messages）与"本次模型请求看到的消息"（chatMessages）分离。
 *
 * 三条纪律：
 * 1. 投影结果绝不写回 context.messages——context.messages 永远保留全文，是权威事实。
 * 2. 溢出压缩恢复后必须重新投影（调用方的 continue 路径回到循环顶会重新执行投影；若未来有人把恢复改成就地重试，必须显式重新投影）。
 * 3. 投影是幂等的——对已是占位符的内容再次投影原样返回。
 */
import type { ChatMessage, ContentBlock } from '../../model/types'
import { buildArtifactRef, sha256Hex } from '../../artifacts/artifactRef'
import { planToolResultSupersession } from './toolResultSupersession'

/** 当轮归档阈值：超过此估算 token 的工具结果替换为占位符 */
export const ACTIVE_TOOL_RESULT_MAX_TOKENS = 2048
/** 字符/token 估算系数，与 estimateContextSize 的 JSON 字符 / 4 口径一致 */
export const CHARS_PER_TOKEN = 4
/** 被覆盖结果的最低归档阈值：低于此体积不归档，避免占位符比原文还大 */
export const SUPERSEDED_MIN_ESTIMATED_TOKENS = 256
/** 单次模型请求允许携带的图片 JSON 字节上限。 */
export const MAX_PROVIDER_IMAGE_REQUEST_BYTES = 12 * 1024 * 1024
/** 图片超过轮预算后保留的可操作提示。 */
export const IMAGE_REQUEST_BUDGET_PLACEHOLDER =
  '[图片已省略：本轮图片请求已超过 12 MiB 上限。请减少图片数量或尺寸后重试。]'
/** 占位符预览：正文前 N 行 */
const PREVIEW_HEAD_LINES = 3
/** 占位符预览：正文后 N 行 */
const PREVIEW_TAIL_LINES = 2

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
  /** 正文头尾预览，供模型多数情况下免回读决策 */
  preview: string
  reason: 'active_current_turn_pruned' | 'superseded_by_newer_result'
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

/** 头尾预览：行数不足时退回全文，避免重复中间省略。 */
export function buildArchiveContentPreview(body: string): string {
  const lines = body.split('\n')
  if (lines.length <= PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES) {
    return body
  }
  const head = lines.slice(0, PREVIEW_HEAD_LINES)
  const tail = lines.slice(-PREVIEW_TAIL_LINES)
  return [...head, '…', ...tail].join('\n')
}

function buildPlaceholder(
  artifactId: string,
  toolCallId: string,
  body: string,
  bodySha256: string,
  reason: ArchivedToolResultPlaceholder['reason'] = 'active_current_turn_pruned'
): string {
  const originalBytes = Buffer.byteLength(body, 'utf8')
  const placeholder: ArchivedToolResultPlaceholder = {
    kind: ARCHIVED_PLACEHOLDER_KIND,
    v: ARCHIVED_PLACEHOLDER_VERSION,
    artifactId,
    resourceRef: buildArtifactRef(artifactId, bodySha256, originalBytes),
    toolCallId,
    toolName: ARCHIVE_TOOL_NAME_TAG,
    sha256: bodySha256,
    originalBytes,
    originalEstimatedTokens: Math.ceil(body.length / CHARS_PER_TOKEN),
    preview: buildArchiveContentPreview(body),
    reason,
    readInstructions: 'This result is archived but still readable. Call archive_read with this ref: operation "inspect" for structure, "search" with keyword to locate content, "read" with offset/limit for a bounded page.'
  }
  return JSON.stringify(placeholder)
}

/** 当轮工具结果归档策略 */
export interface ActiveToolResultPrunePolicy {
  enabled: boolean
  /** 归档阈值（估算 token） */
  maxEstimatedTokens?: number
}

/** 归档候选：一份待写入 artifact 的工具结果原文 */
export interface ArchiveCandidate {
  toolCallId: string
  toolName: string
  body: string
  /** body 的 sha256，用作缓存键与 lineage 依据 */
  bodySha256: string
}

/** 同一 Agent turn 内复用归档占位符，避免历史请求前缀随随机 artifact ID 漂移。 */
export type RequestProjectionArchiveCache = Map<string, string>

export function createRequestProjectionArchiveCache(): RequestProjectionArchiveCache {
  return new Map<string, string>()
}

/**
 * 压缩摘要输入的投影契约：对完整权威消息做与主请求一致的投影，返回投影视图。
 *
 * 调用方（活跃轮次）必须传入复用主请求同一 archiveCache 实例的实现——占位符
 * artifact 指纹跨步骤不漂移是摘要请求与主请求字节前缀恒等的前提，不能改为
 * 独立投影。投影保持逐条 1:1 对齐且不改写 role，调用方按切点切片即可。
 */
export interface SummaryProjection {
  project: (messages: ChatMessage[]) => Promise<ChatMessage[]>
}

export interface RequestProjectionInput {
  messages: ChatMessage[]
  policy: ActiveToolResultPrunePolicy
  /** 由本次 Agent turn 持有，跨模型轮次复用，turn 结束后随循环释放。 */
  archiveCache: RequestProjectionArchiveCache
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

function imageRequestBytes(block: Extract<ContentBlock, { type: 'image_url' }>): number {
  return Buffer.byteLength(JSON.stringify(block), 'utf8')
}

/** 在不改写权威上下文的前提下，按消息顺序限制图片请求体积。 */
function projectImagesWithinBudget(messages: ChatMessage[]): ChatMessage[] {
  let usedBytes = 0
  let changed = false

  const projected = messages.map(message => {
    if (!Array.isArray(message.content)) return message

    let messageChanged = false
    const content: ContentBlock[] = []
    for (const block of message.content) {
      if (block.type !== 'image_url') {
        content.push(block)
        continue
      }

      const bytes = imageRequestBytes(block)
      if (usedBytes + bytes <= MAX_PROVIDER_IMAGE_REQUEST_BYTES) {
        usedBytes += bytes
        content.push(block)
      } else {
        messageChanged = true
        content.push({ type: 'text', text: IMAGE_REQUEST_BUDGET_PLACEHOLDER })
      }
    }

    if (!messageChanged) return message
    changed = true
    return { ...message, content }
  })

  return changed ? projected : messages
}

/** 关闭态策略：门面默认值 */
export const DISABLED_PRUNE_POLICY: ActiveToolResultPrunePolicy = { enabled: false }

/** 仅在模型具备 archive_read 时启用投影归档，避免发出无法回读的占位符。 */
export function resolveRequestProjectionPolicy(
  hasArchiveRead: boolean
): ActiveToolResultPrunePolicy {
  return hasArchiveRead ? { enabled: true } : DISABLED_PRUNE_POLICY
}

export async function projectRequestMessages(
  input: RequestProjectionInput
): Promise<RequestProjectionResult> {
  if (!input.policy.enabled) {
    return { messages: projectImagesWithinBudget(input.messages), diagnostics: EMPTY_DIAGNOSTICS }
  }

  const maxTokens = input.policy.maxEstimatedTokens ?? ACTIVE_TOOL_RESULT_MAX_TOKENS

  const maxChars = maxTokens * CHARS_PER_TOKEN
  const supersededMinChars = SUPERSEDED_MIN_ESTIMATED_TOKENS * CHARS_PER_TOKEN
  // 被更新结果覆盖的旧证据计划：算一次，逐条遍历时复用。
  const supersessionPlan = planToolResultSupersession(input.messages)
  let prunedCount = 0
  let archiveFailures = 0
  let estimatedTokensSaved = 0

  const projected: ChatMessage[] = []

  for (const msg of input.messages) {
    if (msg.role !== 'tool' || !msg.toolCallId) {
      projected.push(msg)
      continue
    }

    // 仅归档纯文本结果：多模态块（如 read 返回的图片）不可归档——
    // 占位符只承载文本，会把图片块丢失；保守跳过。
    const text = typeof msg.content === 'string' ? msg.content : ''
    if (!text) {
      projected.push(msg)
      continue
    }

    // 幂等：已是占位符则原样返回
    if (isArchivedPlaceholder(text)) {
      projected.push(msg)
      continue
    }

    // 两种归档触发：被更新结果覆盖（且原文足够大），或单纯超过体积阈值。
    const superseded = supersessionPlan.has(msg.toolCallId)
      && text.length >= supersededMinChars
    if (!superseded && text.length <= maxChars) {
      projected.push(msg)
      continue
    }
    const reason: ArchivedToolResultPlaceholder['reason'] = superseded
      ? 'superseded_by_newer_result'
      : 'active_current_turn_pruned'

    const bodySha256 = sha256Hex(text)
    const cacheKey = `${msg.toolCallId}:${bodySha256}`

    // 缓存命中则复用占位符
    const cachedPlaceholder = input.archiveCache.get(cacheKey)
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
      bodySha256,
      reason
    )
    input.archiveCache.set(cacheKey, placeholder)
    projected.push({ ...msg, content: placeholder })
    prunedCount++
    estimatedTokensSaved += Math.ceil((text.length - placeholder.length) / CHARS_PER_TOKEN)
  }

  return {
    messages: projectImagesWithinBudget(projected),
    diagnostics: { prunedCount, archiveFailures, estimatedTokensSaved }
  }
}
