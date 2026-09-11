/**
 * 请求投影层：将"权威上下文"（context.messages）与"本次模型请求看到的消息"（chatMessages）分离。
 *
 * 三条纪律：
 * 1. 投影结果绝不写回 context.messages——context.messages 永远保留全文，是权威事实。
 * 2. 溢出压缩恢复后必须重新投影（调用方的 continue 路径回到循环顶会重新执行投影；若未来有人把恢复改成就地重试，必须显式重新投影）。
 * 3. 投影是幂等的——对已是占位符的内容再次投影原样返回。
 *
 * 归档时机：最新一步的工具结果先全文投递一次（deferToolCallIds），模型消费过之后
 * 的请求才按体积/覆盖规则归档。已归档结果的 delivery 由首次归档时的 frozenDeliveries
 * 交回调用方写回权威上下文，此后投影幂等复用该占位符，不回全文。
 *
 * 4. 溢出降级也是投影层改写：命中外来降级集合（omittedImages）的 tool 图片块被机械
 *    替换为固定占位文本，权威上下文仍保留原图；「哪些图可降」的策略由调用方拥有。
 */
import { extractTextFromContent, type ChatMessage, type ContentBlock } from '../model/types'
import { buildArtifactRef, sha256Hex } from '../artifacts/artifactRef'
import { planToolResultSupersession } from './toolResultSupersession'
import { estimateTextTokens } from '../../shared/model/tokenEstimate'

/** 当轮归档阈值：超过此估算 token 的工具结果替换为占位符 */
export const ACTIVE_TOOL_RESULT_MAX_TOKENS = 2048
/** 字符/token 估算系数，与 estimateContextSize 的 JSON 字符 / 4 口径一致 */
export const CHARS_PER_TOKEN = 4
/** 被覆盖结果的最低归档阈值：低于此体积不归档，避免占位符比原文还大 */
export const SUPERSEDED_MIN_ESTIMATED_TOKENS = 256
/**
 * 深位守卫阈值：仅以 superseded 触发的未冻结候选，其后的投递后缀超过该估算
 * token 时保留原文（等压缩整段回收），避免历史中段改写让大段缓存前缀作废。
 * 阈值量级与尾部分布对齐：后缀翻转的中位成本远低于此，深位事件远高于此。
 */
export const SUPERSEDED_DEEP_SUFFIX_TOKENS = 8000
/** 单次模型请求允许携带的图片 JSON 字节上限。 */
export const MAX_PROVIDER_IMAGE_REQUEST_BYTES = 12 * 1024 * 1024
/** 图片超过轮预算后保留的可操作提示。 */
export const IMAGE_REQUEST_BUDGET_PLACEHOLDER =
  '[图片已省略：本轮图片请求已超过 12 MiB 上限。请减少图片数量或尺寸后重试。]'
/**
 * 溢出降级占位符：可省略的历史工具图片被替换为该固定文案。
 * 无 archive_read 指引（与归档占位符语义不同）；同一降级集合生命周期内逐字节稳定。
 */
export const IMAGE_OVERFLOW_OMITTED_PLACEHOLDER =
  '[图片已省略：历史图片因上下文溢出恢复被移除。如确需该图内容，请重新发送。]'
/** 占位符预览：正文前 N 行 */
const PREVIEW_HEAD_LINES = 3
/** 占位符预览：正文后 N 行 */
const PREVIEW_TAIL_LINES = 2
/** 预览的字符硬上限；单行与超长行也不能让占位符反向膨胀。 */
const PREVIEW_MAX_CHARS = 800

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
  /** 归档原因：模型消费过全文后按体积归档，或被更新的结果覆盖 */
  reason: 'consumed_then_archived' | 'superseded_by_newer_result'
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

/** 头尾预览同时受行数和字符数约束。 */
export function buildArchiveContentPreview(body: string): string {
  const lines = body.split('\n')
  const linePreview = lines.length <= PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES
    ? body
    : [
        ...lines.slice(0, PREVIEW_HEAD_LINES),
        '…',
        ...lines.slice(-PREVIEW_TAIL_LINES)
      ].join('\n')
  if (linePreview.length <= PREVIEW_MAX_CHARS) return linePreview

  const omission = '\n…\n'
  const edgeChars = Math.floor((PREVIEW_MAX_CHARS - omission.length) / 2)
  return `${linePreview.slice(0, edgeChars)}${omission}${linePreview.slice(-edgeChars)}`
}
function isSmallerWireContent(original: string, projected: string): boolean {
  if (projected.length >= original.length) return false
  return Buffer.byteLength(JSON.stringify(projected), 'utf8')
    < Buffer.byteLength(JSON.stringify(original), 'utf8')
}

function buildPlaceholder(
  artifactId: string,
  toolCallId: string,
  body: string,
  bodySha256: string,
  reason: ArchivedToolResultPlaceholder['reason'] = 'consumed_then_archived'
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
    readInstructions: 'This result is archived but still readable. You saw its full text in a previous request; read back only when you need exact details. Call archive_read with this ref: operation "inspect" for structure, "search" with keyword to locate content, "read" with offset/limit for a bounded page.'
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
 * 溢出降级同理：活跃轮次的摘要投影必须传入与主请求同源的 omittedImages 集合，
 * 两个视图对同一图片的替换决策才能保持一致。
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
  /**
   * 最新一步刚提交的工具调用 id：其结果在紧随其后的那次请求中全文投递，
   * 体积与覆盖归档都从再下一次请求开始生效。
   */
  deferToolCallIds?: ReadonlySet<string>
  /**
   * 溢出降级集合：元素为 `${toolCallId}:${imageBlockFingerprint(url)}`，由调用方（Agent turn）拥有。
   * 投影只做机械替换：命中复合键的 tool 图片块 → 固定占位文本；user 图片与无 toolCallId 的消息不受影响。
   */
  omittedImages?: ReadonlySet<string>
}

export interface RequestProjectionDiagnostics {
  prunedCount: number
  archiveFailures: number
  estimatedTokensSaved: number
}

/** 首次归档时交回调用方的冻结投递；写回权威上下文与发事件的 Owner 是调用方。 */
export interface FrozenToolDelivery {
  toolCallId: string
  delivery: NonNullable<ChatMessage['toolDelivery']>
}

export interface RequestProjectionResult {
  messages: ChatMessage[]
  /** 诊断用，不进模型上下文 */
  diagnostics: RequestProjectionDiagnostics
  /** 本次投影里首次被归档的结果；再次投影同一消息不会再产生条目（幂等）。 */
  frozenDeliveries: FrozenToolDelivery[]
}

const EMPTY_DIAGNOSTICS: RequestProjectionDiagnostics = {
  prunedCount: 0,
  archiveFailures: 0,
  estimatedTokensSaved: 0
}

const EMPTY_DEFER_SET: ReadonlySet<string> = new Set()

/** 图片块指纹：溢出降级复合键 `${toolCallId}:${fingerprint}` 的组成单元，与 Owner 共用同一实现。 */
export function imageBlockFingerprint(url: string): string {
  return sha256Hex(url)
}

/** 机械替换：命中复合键的 tool 图片块 → 固定占位文本；不改写输入消息，未命中时原样返回。 */
function applyOmittedImages(
  messages: ChatMessage[],
  omittedImages: ReadonlySet<string> | undefined
): ChatMessage[] {
  if (!omittedImages || omittedImages.size === 0) return messages
  let changed = false
  const mapped = messages.map(message => {
    if (message.role !== 'tool' || !message.toolCallId || !Array.isArray(message.content)) return message
    const toolCallId = message.toolCallId
    let messageChanged = false
    const content: ContentBlock[] = message.content.map(block => {
      if (block.type !== 'image_url') return block
      if (!omittedImages.has(`${toolCallId}:${imageBlockFingerprint(block.image_url.url)}`)) return block
      messageChanged = true
      return { type: 'text', text: IMAGE_OVERFLOW_OMITTED_PLACEHOLDER }
    })
    if (!messageChanged) return message
    changed = true
    return { ...message, content }
  })
  return changed ? mapped : messages
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
  const frozenDeliveries: FrozenToolDelivery[] = []
  // 降级先于所有分支统一应用：早退路径、归档判定、深位后缀计量与 12 MiB 预算都按降级后形态计算。
  const sourceMessages = applyOmittedImages(input.messages, input.omittedImages)
  if (!input.policy.enabled) {
    return {
      messages: projectImagesWithinBudget(sourceMessages),
      diagnostics: EMPTY_DIAGNOSTICS,
      frozenDeliveries
    }
  }

  const maxTokens = input.policy.maxEstimatedTokens ?? ACTIVE_TOOL_RESULT_MAX_TOKENS
  const deferToolCallIds = input.deferToolCallIds ?? EMPTY_DEFER_SET

  const maxChars = maxTokens * CHARS_PER_TOKEN
  const supersededMinChars = SUPERSEDED_MIN_ESTIMATED_TOKENS * CHARS_PER_TOKEN
  // 被更新结果覆盖的旧证据计划：算一次，逐条遍历时复用。
  const supersessionPlan = planToolResultSupersession(sourceMessages)
  let prunedCount = 0
  let archiveFailures = 0
  let estimatedTokensSaved = 0

  const projected: ChatMessage[] = []

  // 深位守卫的后缀计量表按需构建：多数请求没有纯 superseded 候选，零成本跳过。
  let suffixTokensAfter: number[] | null = null
  const suffixAfter = (index: number): number => {
    if (!suffixTokensAfter) {
      suffixTokensAfter = new Array(sourceMessages.length).fill(0)
      for (let j = sourceMessages.length - 2; j >= 0; j--) {
        suffixTokensAfter[j] = suffixTokensAfter[j + 1]! + estimateDeliveredMessageTokens(sourceMessages[j + 1]!)
      }
    }
    return suffixTokensAfter[index] ?? 0
  }

  for (let index = 0; index < sourceMessages.length; index++) {
    const msg = sourceMessages[index]!
    if (msg.role !== 'tool' || !msg.toolCallId) {
      projected.push(msg)
      continue
    }

    // 已冻结的归档表示：幂等复用占位符，绝不回到全文
    if (msg.toolDelivery?.kind === 'archive') {
      if (typeof msg.content !== 'string' || sha256Hex(msg.content) !== msg.toolDelivery.bodySha256) {
        throw new Error('Tool delivery does not match its source body')
      }
      projected.push({ ...msg, content: msg.toolDelivery.placeholder })
      continue
    }

    // 最新一步的结果：全文投递一次；体积与覆盖归档从下一请求开始
    if (deferToolCallIds.has(msg.toolCallId)) {
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
    const oversize = text.length > maxChars
    if (!superseded && !oversize) {
      projected.push(msg)
      continue
    }
    // 深位守卫：仅以 superseded 触发（不超重）且尚未冻结的候选，其后缀仍深时
    // 保留原文、等压缩整段回收——中段改写会让其后全部缓存前缀作废。
    // 双重命中（既被覆盖又超体积阈值）按体积归档放行，守卫不适用。
    if (superseded && !oversize && suffixAfter(index) > SUPERSEDED_DEEP_SUFFIX_TOKENS) {
      projected.push(msg)
      continue
    }
    const reason: ArchivedToolResultPlaceholder['reason'] = superseded
      ? 'superseded_by_newer_result'
      : 'consumed_then_archived'

    const bodySha256 = sha256Hex(text)
    const cacheKey = `${msg.toolCallId}:${bodySha256}`

    // 缓存命中则复用占位符
    const cachedPlaceholder = input.archiveCache.get(cacheKey)
    if (cachedPlaceholder !== undefined) {
      if (!isSmallerWireContent(text, cachedPlaceholder)) {
        projected.push(msg)
        continue
      }
      projected.push({ ...msg, content: cachedPlaceholder })
      prunedCount++
      estimatedTokensSaved += Math.ceil((text.length - cachedPlaceholder.length) / CHARS_PER_TOKEN)
      frozenDeliveries.push({
        toolCallId: msg.toolCallId,
        delivery: { version: 1, kind: 'archive', bodySha256, placeholder: cachedPlaceholder }
      })
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
    if (!isSmallerWireContent(text, placeholder)) {
      projected.push(msg)
      continue
    }
    input.archiveCache.set(cacheKey, placeholder)
    projected.push({ ...msg, content: placeholder })
    prunedCount++
    estimatedTokensSaved += Math.ceil((text.length - placeholder.length) / CHARS_PER_TOKEN)
    frozenDeliveries.push({
      toolCallId: msg.toolCallId,
      delivery: { version: 1, kind: 'archive', bodySha256, placeholder }
    })
  }

  return {
    messages: projectImagesWithinBudget(projected),
    diagnostics: { prunedCount, archiveFailures, estimatedTokensSaved },
    frozenDeliveries
  }
}

/**
 * 本请求实际投递形态的 token 估算：冻结归档按占位符计（不是原文），
 * reasoningContent 计入（回放档案真实携带该字节），image_url 块按 URL 线上字节计
 * （上下文构建期 nova-image:// 已解析为 data URL）。深位守卫与离线回放共用此口径。
 */
export function estimateDeliveredMessageTokens(msg: ChatMessage): number {
  const content = msg.toolDelivery?.kind === 'archive' ? msg.toolDelivery.placeholder : msg.content
  let total = estimateTextTokens(extractTextFromContent(content))
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'image_url') total += estimateTextTokens(block.image_url.url)
    }
  }
  if (msg.toolCalls) {
    for (const toolCall of msg.toolCalls) total += estimateTextTokens(toolCall.arguments)
  }
  total += estimateTextTokens(msg.reasoningContent ?? '')
  return total
}

/**
 * 提交时登记"原文投递"表示：最新结果先全文进下一次请求；归档发生在
 * 首次投影归档时（frozenDeliveries），由调用方写回权威上下文。
 */
export function originalToolDelivery(content: string): NonNullable<ChatMessage['toolDelivery']> {
  return { version: 1, kind: 'original', bodySha256: sha256Hex(content) }
}
