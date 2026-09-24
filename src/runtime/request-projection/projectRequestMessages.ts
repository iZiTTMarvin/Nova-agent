/**
 * 请求投影层：将"权威上下文"（context.messages）与"本次模型请求看到的消息"（chatMessages）分离。
 *
 * 三条纪律：
 * 1. 投影结果绝不写回 context.messages——context.messages 永远保留全文，是权威事实。
 * 2. 溢出压缩恢复后必须重新投影（调用方的 continue 路径回到循环顶会重新执行投影；若未来有人把恢复改成就地重试，必须显式重新投影）。
 * 3. 投影是幂等的——对已是占位符的内容再次投影原样返回。
 *
 * 归档时机：最新一步的工具结果先全文投递一次（deferToolCallIds）。体积归档只在
 * 结果滑出最近投递窗口（protectRecentTokens）且本批可回收总量达标（minSavingsTokens）
 * 时批量发生；批量候选共享最早断点，按回本收益或压力纾解比统一选切点。
 * 被更新结果覆盖的候选满足深位守卫仍立即归档，深位且超体积的并入体积批量。
 * 已归档结果的 delivery 由首次归档时的 frozenDeliveries
 * 交回调用方写回权威上下文，此后投影幂等复用该占位符，不回全文。
 *
 * 4. 溢出降级也是投影层改写：命中外来降级集合（omittedImages）的 tool 图片块被机械
 *    替换为固定占位文本，权威上下文仍保留原图；「哪些图可降」的策略由调用方拥有。
 */
import { extractTextFromContent, type ChatMessage, type ContentBlock } from '../model/types'
import { buildArtifactRef, sha256Hex } from '../artifacts/artifactRef'
import { planToolResultSupersession } from './toolResultSupersession'
import { estimateTextTokens } from '../../shared/model/tokenEstimate'
import type { CacheEconomics } from '../model/cacheProfile'
import { recordMetric } from '../../shared/diagnostics/metrics'

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

/** 低压力层的携带地平线（请求数）；待真实对照实验标定 */
export const DEFAULT_CARRY_HORIZON_ROUNDS = 12
/** 纾解层的最低 R/S：低于此值时按 token 账压缩反而更省，纾解只在可回收量至少与重建后缀相当时替代压缩 */
export const RELIEF_MIN_SAVINGS_RATIO = 1.0
/** 距压缩阈值不足该比例的上下文窗口时进入纾解层 */
export const RELIEF_HEADROOM_RATIO = 0.1

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
    readInstructions: 'This result is archived but still readable. You saw its full text in a previous request; read back only when you need exact details. Call archive_read with this ref: operation "inspect" for structure, "search" with keyword to locate content, "read" with offset/limit for a bounded page. If it was a file read, calling read on the file again (with offset/limit) is equally fine.'
  }
  return JSON.stringify(placeholder)
}

/** 归档经济门槛参数；缺省时批量只按 minSavingsTokens 裁决 */
export interface ArchiveEconomics extends CacheEconomics {
  /** 低压力层假设可回收内容还要携带的请求数 N̂ */
  carryHorizonRounds: number
  /** 纾解层允许的最低 回收/重建 比 R/S */
  reliefMinSavingsRatio: number
  /** 距压缩阈值的剩余空间（估算 token）；给定时携带地平线取 min(N̂, 剩余空间 / 本会话平均每请求增长) */
  headroomTokens?: number
}

/** 当轮工具结果归档策略 */
export interface ActiveToolResultPrunePolicy {
  enabled: boolean
  /** 归档阈值（估算 token） */
  maxEstimatedTokens?: number
  /** 最近投递窗口：其后投递后缀不足该 token 数的结果视为仍在工作集，不因体积归档；缺省 0 */
  protectRecentTokens?: number
  /** 本次体积归档候选可回收 token 总量不足该值时全部保留原文，减少缓存前缀断裂次数；缺省 0 */
  minSavingsTokens?: number
  /** 归档经济门槛；缺省时批量只按 minSavingsTokens 裁决 */
  economics?: ArchiveEconomics
  /**
   * 'relief'：上下文接近压缩阈值，批量归档改用纾解规则（不要求回本，只要求 R/S 达标），
   * 用无损归档替代有损整段压缩；缺省 'economic'
   */
  pressure?: 'economic' | 'relief'
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
  /** 本次批量归档裁决；没有批量候选时为 null */
  batch: ArchiveBatchDecision | null
}

export interface ArchiveBatchDecision {
  mode: 'legacy' | 'economic' | 'relief'
  candidateCount: number
  admittedCount: number
  /** 采纳切点的净回收 R 与断点后存活后缀 S（估算 token）；未采纳时取评估过的最优切点 */
  savingsTokens: number
  rebuildSuffixTokens: number
  /** 经济层净收益 G；其他模式为 null */
  netBenefitTokens: number | null
  /** 经济层实际使用的携带地平线（请求数）；其他模式为 null */
  carryRounds: number | null
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
  estimatedTokensSaved: 0,
  batch: null
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

/** 占位符 JSON 外壳（kind/ref/指令等字段）的估算 token，约 600 字符 */
const ARCHIVED_PLACEHOLDER_ENVELOPE_TOKENS = 150

/** 单条结果归档为占位符的净节省估算：原文 − 预览 − 占位符外壳。 */
function estimateArchiveSavingsTokens(text: string): number {
  return Math.max(
    0,
    estimateTextTokens(text) - estimateTextTokens(buildArchiveContentPreview(text)) - ARCHIVED_PLACEHOLDER_ENVELOPE_TOKENS
  )
}

/** 关闭态策略：门面默认值 */
export const DISABLED_PRUNE_POLICY: ActiveToolResultPrunePolicy = { enabled: false }

/** 最近窗口保护上限（token），防止超大窗口把全部历史都视为"正在用" */
export const PROTECT_RECENT_TOKENS_CAP = 40_000
/** 最近窗口占上下文窗口的比例 */
export const PROTECT_RECENT_WINDOW_RATIO = 0.2
/** 批量归档最低可回收量上限（token） */
export const MIN_SAVINGS_TOKENS_CAP = 20_000
/** 批量归档最低可回收量占上下文窗口的比例 */
export const MIN_SAVINGS_WINDOW_RATIO = 0.1

export interface RequestProjectionPolicyOptions {
  /** 来自 CacheProfile；缺省不启用经济门槛 */
  economics?: CacheEconomics
  /** 压缩服务最近一次预算评估快照；缺省视为低压力 */
  budget?: { estimatedTokens: number; threshold: number; contextWindow: number }
}

/**
 * 仅在模型具备 archive_read 时启用投影归档，避免发出无法回读的占位符。
 * 预算逼近压缩阈值时进入纾解层：批量归档按 R/S 裁决，用无损归档替代有损压缩。
 */
export function resolveRequestProjectionPolicy(
  hasArchiveRead: boolean,
  contextWindow: number,
  options?: RequestProjectionPolicyOptions
): ActiveToolResultPrunePolicy {
  if (!hasArchiveRead) return DISABLED_PRUNE_POLICY
  const policy: ActiveToolResultPrunePolicy = {
    enabled: true,
    protectRecentTokens: Math.min(PROTECT_RECENT_TOKENS_CAP, Math.floor(contextWindow * PROTECT_RECENT_WINDOW_RATIO)),
    minSavingsTokens: Math.min(MIN_SAVINGS_TOKENS_CAP, Math.floor(contextWindow * MIN_SAVINGS_WINDOW_RATIO))
  }
  if (options?.economics) {
    policy.economics = {
      readRatio: options.economics.readRatio,
      writePremium: options.economics.writePremium,
      carryHorizonRounds: DEFAULT_CARRY_HORIZON_ROUNDS,
      reliefMinSavingsRatio: RELIEF_MIN_SAVINGS_RATIO
    }
  }
  const budget = options?.budget
  if (budget && policy.economics) {
    policy.economics.headroomTokens = Math.max(0, budget.threshold - budget.estimatedTokens)
  }
  if (budget && budget.estimatedTokens >= budget.threshold - Math.floor(budget.contextWindow * RELIEF_HEADROOM_RATIO)) {
    policy.pressure = 'relief'
  }
  return policy
}

/**
 * 批量归档裁决：所有候选共享最早断点，按切点 k（归档批内第 k 个及之后全部候选）评估。
 * R_k 为切点后净回收总量；S_k 为断点后需按全价重建的存活后缀
 * （newTailStart 起是本请求新付费的尾部，不计入重建）。返回批内序号；null 表示全部保留。
 */
function resolveArchiveBatch(args: {
  /** 批量候选在 sourceMessages 中的下标（升序）与各自净回收估算 */
  candidates: Array<{ index: number; savingsTokens: number }>
  /** 投递形态下第 i 条消息到末尾的 token 估算；i === messages.length 时为 0 */
  tokensFrom: (index: number) => number
  /** 本请求新付费尾部起点：延迟投递批次对应的 assistant 消息下标 */
  newTailStart: number
  /** 本会话平均每请求增长的估算 token（tokensFrom(0) / assistant 条数），用于截断携带地平线 */
  averageGrowthTokens: number
  minSavingsTokens: number
  economics?: ArchiveEconomics
  pressure?: 'economic' | 'relief'
}): { admitFrom: number | null; decision: ArchiveBatchDecision } {
  const { candidates, tokensFrom, newTailStart, averageGrowthTokens, minSavingsTokens, economics, pressure } = args
  const n = candidates.length
  const savingsAfter = new Array<number>(n)
  let acc = 0
  for (let k = n - 1; k >= 0; k--) {
    acc += candidates[k]!.savingsTokens
    savingsAfter[k] = acc
  }
  const tailTokens = tokensFrom(newTailStart)
  const rebuildSuffix = (k: number): number =>
    Math.max(0, tokensFrom(candidates[k]!.index) - tailTokens - savingsAfter[k]!)
  const report = (k: number, admitFrom: number | null, netBenefitTokens: number | null, mode: ArchiveBatchDecision['mode'], carryRounds: number | null) => ({
    admitFrom,
    decision: {
      mode,
      candidateCount: n,
      admittedCount: admitFrom === null ? 0 : n - admitFrom,
      savingsTokens: savingsAfter[k]!,
      rebuildSuffixTokens: rebuildSuffix(k),
      netBenefitTokens,
      carryRounds
    }
  })

  // 无经济参数：总量达标即整批归档，与历史行为一致
  if (!economics) {
    return report(0, savingsAfter[0]! >= minSavingsTokens ? 0 : null, null, 'legacy', null)
  }

  // 纾解层：逼近压缩阈值，不要求回本，只要求回收量相对重建后缀达标
  if (pressure === 'relief') {
    let firstEligible = -1
    for (let k = 0; k < n; k++) {
      if (savingsAfter[k]! < minSavingsTokens) continue
      if (firstEligible < 0) firstEligible = k
      if (savingsAfter[k]! >= economics.reliefMinSavingsRatio * rebuildSuffix(k)) {
        return report(k, k, null, 'relief', null)
      }
    }
    return report(firstEligible >= 0 ? firstEligible : 0, null, null, 'relief', null)
  }

  // 经济层：在达标切点中取净收益 G = α·N̂·R − (β−α)·S 最大者，G > 0 才采纳。
  // 携带地平线按压缩距离截断：越近压缩，内容被携带的次数越少，改写越不值。
  // 纾解层不受此影响——它的对手是压缩本身，不是携带成本。
  const { readRatio, writePremium, carryHorizonRounds } = economics
  const horizon = economics.headroomTokens === undefined
    ? carryHorizonRounds
    : Math.min(carryHorizonRounds, Math.max(1, Math.floor(economics.headroomTokens / Math.max(1, averageGrowthTokens))))
  let bestK = -1
  let bestGain = -Infinity
  for (let k = 0; k < n; k++) {
    if (savingsAfter[k]! < minSavingsTokens) continue
    const gain = readRatio * horizon * savingsAfter[k]! - (writePremium - readRatio) * rebuildSuffix(k)
    // 并列取更靠后的切点：断点更浅，重建范围更小
    if (gain >= bestGain) {
      bestGain = gain
      bestK = k
    }
  }
  if (bestK < 0) {
    const gain0 = readRatio * horizon * savingsAfter[0]! - (writePremium - readRatio) * rebuildSuffix(0)
    return report(0, null, gain0, 'economic', horizon)
  }
  return report(bestK, bestGain > 0 ? bestK : null, bestGain, 'economic', horizon)
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
  const protectRecentTokens = input.policy.protectRecentTokens ?? 0
  const minSavingsTokens = input.policy.minSavingsTokens ?? 0
  const deferToolCallIds = input.deferToolCallIds ?? EMPTY_DEFER_SET

  const maxChars = maxTokens * CHARS_PER_TOKEN
  const supersededMinChars = SUPERSEDED_MIN_ESTIMATED_TOKENS * CHARS_PER_TOKEN
  // 被更新结果覆盖的旧证据计划：算一次，逐条遍历时复用。
  const supersessionPlan = planToolResultSupersession(sourceMessages)
  let prunedCount = 0
  let archiveFailures = 0
  let estimatedTokensSaved = 0

  const projected: ChatMessage[] = []

  // 深位守卫与最近窗口的后缀计量表按需构建：多数请求没有候选，零成本跳过。
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

  // 阶段 1 逐条分类，只记决定不做归档 IO；体积候选先入批量集合，阶段 2 按可回收总量统一裁决。
  type Decision =
    | { kind: 'passthrough' }
    | { kind: 'placeholder'; placeholder: string }
    | {
        kind: 'archive'
        toolCallId: string
        text: string
        reason: ArchivedToolResultPlaceholder['reason']
        immediate: boolean
      }
  const decisions: Decision[] = []

  for (let index = 0; index < sourceMessages.length; index++) {
    const msg = sourceMessages[index]!
    if (msg.role !== 'tool' || !msg.toolCallId) {
      decisions.push({ kind: 'passthrough' })
      continue
    }

    // 已冻结的归档表示：幂等复用占位符，绝不回到全文
    if (msg.toolDelivery?.kind === 'archive') {
      if (typeof msg.content !== 'string' || sha256Hex(msg.content) !== msg.toolDelivery.bodySha256) {
        throw new Error('Tool delivery does not match its source body')
      }
      decisions.push({ kind: 'placeholder', placeholder: msg.toolDelivery.placeholder })
      continue
    }

    // 最新一步的结果：全文投递一次；体积与覆盖归档从下一请求开始
    if (deferToolCallIds.has(msg.toolCallId)) {
      decisions.push({ kind: 'passthrough' })
      continue
    }

    // 仅归档纯文本结果：多模态块（如 read 返回的图片）不可归档——
    // 占位符只承载文本，会把图片块丢失；保守跳过。
    const text = typeof msg.content === 'string' ? msg.content : ''
    if (!text) {
      decisions.push({ kind: 'passthrough' })
      continue
    }

    // 幂等：已是占位符则原样返回
    if (isArchivedPlaceholder(text)) {
      decisions.push({ kind: 'passthrough' })
      continue
    }

    // 两种归档触发：被更新结果覆盖（且原文足够大），或单纯超过体积阈值。
    const superseded = supersessionPlan.has(msg.toolCallId)
      && text.length >= supersededMinChars
    const oversize = text.length > maxChars
    if (!superseded && !oversize) {
      decisions.push({ kind: 'passthrough' })
      continue
    }

    const suffix = suffixAfter(index)
    // 深位守卫：仅以 superseded 触发且后缀仍深的候选保留原文、等压缩整段回收——
    // 中段改写会让其后全部缓存前缀作废。双重命中（superseded + 超体积）深位时
    // 并入体积批量，由最近窗口与批量门槛统一裁决。
    if (superseded && suffix <= SUPERSEDED_DEEP_SUFFIX_TOKENS) {
      decisions.push({
        kind: 'archive',
        toolCallId: msg.toolCallId,
        text,
        reason: 'superseded_by_newer_result',
        immediate: true
      })
      continue
    }
    // 体积候选：其后投递后缀超过最近窗口才可归档，模型正在使用的内容不动。
    if (oversize && (protectRecentTokens <= 0 || suffix > protectRecentTokens)) {
      decisions.push({
        kind: 'archive',
        toolCallId: msg.toolCallId,
        text,
        reason: superseded ? 'superseded_by_newer_result' : 'consumed_then_archived',
        immediate: false
      })
      continue
    }
    decisions.push({ kind: 'passthrough' })
  }

  // 批量裁决：候选共享最早断点，按政策模式（legacy / economic / relief）统一选切点。
  const batchCandidates: Array<{ index: number; savingsTokens: number }> = []
  for (let index = 0; index < decisions.length; index++) {
    const decision = decisions[index]!
    if (decision.kind === 'archive' && !decision.immediate) {
      batchCandidates.push({ index, savingsTokens: estimateArchiveSavingsTokens(decision.text) })
    }
  }
  // 新付费尾部起点：最新一批工具调用对应的 assistant 消息；其后的输入本请求无论如何全价计费
  const deferredHead = sourceMessages.findIndex(
    m => m.role === 'assistant' && (m.toolCalls?.some(call => deferToolCallIds.has(call.id)) ?? false)
  )
  const newTailStart = deferredHead >= 0 ? deferredHead : sourceMessages.length
  const tokensFrom = (index: number): number =>
    index >= sourceMessages.length ? 0 : estimateDeliveredMessageTokens(sourceMessages[index]!) + suffixAfter(index)

  // 平均每请求增长：用总量 / assistant 步数估算；含系统提示会略高估，即偏保守
  let averageGrowthTokens = 0
  if (batchCandidates.length > 0) {
    const assistantCount = sourceMessages.reduce((count, m) => count + (m.role === 'assistant' ? 1 : 0), 0)
    averageGrowthTokens = tokensFrom(0) / Math.max(1, assistantCount)
  }
  const batch = batchCandidates.length > 0
    ? resolveArchiveBatch({
        candidates: batchCandidates,
        tokensFrom,
        newTailStart,
        averageGrowthTokens,
        minSavingsTokens,
        economics: input.policy.economics,
        pressure: input.policy.pressure
      }).decision
    : null
  if (batch) {
    recordMetric('projection.archive_batch', {
      candidateCount: batch.candidateCount,
      admittedCount: batch.admittedCount,
      savingsTokens: batch.savingsTokens,
      rebuildSuffixTokens: batch.rebuildSuffixTokens,
      ...(batch.netBenefitTokens !== null ? { netBenefitTokens: batch.netBenefitTokens } : {}),
      ...(batch.carryRounds !== null ? { carryRounds: batch.carryRounds } : {})
    }, { tags: { mode: batch.mode, admitted: batch.admittedCount > 0 ? '1' : '0' } })
  }
  const admitFrom = batch === null
    ? null
    : batch.admittedCount > 0 ? batch.candidateCount - batch.admittedCount : null

  // 阶段 2：按决定产出投影，归档回调仍按消息顺序串行执行。
  let batchOrdinal = 0
  for (let index = 0; index < sourceMessages.length; index++) {
    const msg = sourceMessages[index]!
    const decision = decisions[index]!
    if (decision.kind === 'passthrough') {
      projected.push(msg)
      continue
    }
    if (decision.kind === 'placeholder') {
      projected.push({ ...msg, content: decision.placeholder })
      continue
    }
    if (!decision.immediate) {
      const position = batchOrdinal++
      if (admitFrom === null || position < admitFrom) {
        projected.push(msg)
        continue
      }
    }

    const text = decision.text
    const bodySha256 = sha256Hex(text)
    const cacheKey = `${decision.toolCallId}:${bodySha256}`

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
        toolCallId: decision.toolCallId,
        delivery: { version: 1, kind: 'archive', bodySha256, placeholder: cachedPlaceholder }
      })
      continue
    }

    // 写入 artifact；archive 回调不得抛异常，失败表达为 null（保留原文）
    const archived = await input.archive({
      toolCallId: decision.toolCallId,
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
      decision.toolCallId,
      text,
      bodySha256,
      decision.reason
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
      toolCallId: decision.toolCallId,
      delivery: { version: 1, kind: 'archive', bodySha256, placeholder }
    })
  }

  return {
    messages: projectImagesWithinBudget(projected),
    diagnostics: { prunedCount, archiveFailures, estimatedTokensSaved, batch },
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
