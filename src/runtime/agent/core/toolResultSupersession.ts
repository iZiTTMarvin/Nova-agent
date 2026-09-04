/**
 * toolResultSupersession — 识别历史中「已被更新结果覆盖」的工具结果。
 *
 * 纯函数：只读输入，不写 artifact、不 mutate。
 * 保守原则贯穿全模块：任何解析或判定不确定一律不计入，保留原文交由调用方处理。
 */
import type { ChatMessage } from '../../model/types'
import { extractTextFromContent } from '../../model/types'
import { isToolFailureText } from '../../../shared/toolResultStatus'
import { resolveToolArg } from '../../tools/toolArgResolver'

export type SupersessionReason =
  | 'exact_duplicate'
  | 'read_range_covered'
  | 'idempotent_snapshot'

/** toolCallId → 被覆盖的原因 */
export type SupersessionPlan = ReadonlyMap<string, SupersessionReason>

/**
 * exact_duplicate 仅对纯读取工具生效；bash 的重复调用由
 * idempotent_snapshot 白名单单独判定，写工具与交互工具一律不触碰。
 */
const EXACT_DUPLICATE_TOOLS = new Set([
  'read',
  'ls',
  'grep',
  'find',
  'archive_read',
  'history_read',
  'memory_search',
  'web_search'
])

interface ToolResultEntry {
  toolCallId: string
  toolName: string
  args: string
  argRecord: Record<string, unknown> | undefined
  success: boolean
  index: number
}

/** 解析工具参数 JSON；非对象/数组/解析失败一律返回 undefined。 */
function parseArgsRecord(args: string): Record<string, unknown> | undefined {
  if (!args) return undefined
  try {
    const parsed = JSON.parse(args) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 配对 assistant.toolCalls 与 role:'tool' 结果，建立可判定条目表。
 * 无配对声明的孤儿结果跳过（不参与也不被覆盖）。
 */
function buildToolResultEntries(
  messages: readonly ChatMessage[]
): ToolResultEntry[] {
  const callMeta = new Map<string, { toolName: string; args: string }>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.toolCalls) continue
    for (const tc of msg.toolCalls) {
      if (tc && tc.id && !callMeta.has(tc.id)) {
        callMeta.set(tc.id, { toolName: tc.name, args: tc.arguments })
      }
    }
  }

  const entries: ToolResultEntry[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'tool' || !msg.toolCallId) continue
    const meta = callMeta.get(msg.toolCallId)
    if (!meta) continue
    const contentText = extractTextFromContent(msg.content)
    entries.push({
      toolCallId: msg.toolCallId,
      toolName: meta.toolName,
      args: meta.args,
      argRecord: parseArgsRecord(meta.args),
      success: !isToolFailureText(contentText),
      index: i
    })
  }
  return entries
}

// ── exact_duplicate ──────────────────────────────────────────────────────────

/** 同工具+同参数的规范化键；解析失败时退回原始 args 文本。 */
function duplicateKey(entry: ToolResultEntry): string {
  const rec = entry.argRecord
  if (rec === undefined) {
    return `${entry.toolName}\u0000${entry.args}`
  }
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(rec).sort()) sorted[k] = rec[k]
  return `${entry.toolName}\u0000${JSON.stringify(sorted)}`
}

/**
 * 「组内保留最新成功结果，其余较旧的标记 exact_duplicate」。
 * 失败结果不作为覆盖者：只有成功结果能覆盖；被覆盖者自身成败不限。
 */
function applyExactDuplicate(
  entries: ToolResultEntry[],
  plan: Map<string, SupersessionReason>
): void {
  const groups = new Map<string, ToolResultEntry[]>()
  for (const e of entries) {
    if (!EXACT_DUPLICATE_TOOLS.has(e.toolName)) continue
    const key = duplicateKey(e)
    const g = groups.get(key) ?? []
    g.push(e)
    groups.set(key, g)
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue
    g.sort((a, b) => a.index - b.index)
    let coverer: ToolResultEntry | undefined
    for (const e of g) if (e.success) coverer = e
    if (!coverer) continue
    for (const e of g) {
      if (e.index < coverer.index && !plan.has(e.toolCallId)) {
        plan.set(e.toolCallId, 'exact_duplicate')
      }
    }
  }
}

// ── read_range_covered ───────────────────────────────────────────────────────

interface ReadRange {
  offset: number
  limit: number
}

/**
 * 解析 read 的 offset/limit，语义与 readTool 对齐：
 * offset 默认 0；limit 缺省或 <1 都表示「读到文件末尾」（Infinity）；
 * 非法数值返回 undefined（不参与判定）。
 */
function readRange(rec: Record<string, unknown> | undefined): ReadRange | undefined {
  if (!rec) return undefined
  const rawOffset = rec.offset
  let offset: number
  if (rawOffset === undefined || rawOffset === null) {
    offset = 0
  } else if (typeof rawOffset === 'number' && Number.isFinite(rawOffset) && rawOffset >= 0) {
    offset = rawOffset
  } else {
    return undefined
  }
  const rawLimit = rec.limit
  let limit: number
  if (rawLimit === undefined || rawLimit === null) {
    limit = Infinity
  } else if (typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit >= 1) {
    limit = rawLimit
  } else if (typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit < 1) {
    limit = Infinity
  } else {
    return undefined
  }
  return { offset, limit }
}

/** j 的读取范围是否完全包含 i 的范围。 */
function rangeCovers(j: ReadRange, i: ReadRange): boolean {
  if (j.offset > i.offset) return false
  if (j.limit === Infinity) return true
  if (i.limit === Infinity) return false
  return j.offset + j.limit >= i.offset + i.limit
}

function applyReadRangeCovered(
  entries: ToolResultEntry[],
  plan: Map<string, SupersessionReason>
): void {
  interface ReadItem {
    entry: ToolResultEntry
    range: ReadRange
  }
  const groups = new Map<string, ReadItem[]>()
  for (const e of entries) {
    if (e.toolName !== 'read') continue
    // 路径别名与 readTool 同源（toolArgResolver），避免两份清单漂移
    const filePath = resolveToolArg(e.argRecord ?? {}, 'path')
    const range = readRange(e.argRecord)
    if (!filePath || !range) continue
    const g = groups.get(filePath) ?? []
    g.push({ entry: e, range })
    groups.set(filePath, g)
  }
  for (const g of groups.values()) {
    for (const iItem of g) {
      for (const jItem of g) {
        if (jItem.entry.index <= iItem.entry.index) continue
        if (!jItem.entry.success) continue
        if (rangeCovers(jItem.range, iItem.range)) {
          if (!plan.has(iItem.entry.toolCallId)) {
            plan.set(iItem.entry.toolCallId, 'read_range_covered')
          }
          break
        }
      }
    }
  }
}

// ── idempotent_snapshot ──────────────────────────────────────────────────────

/** 只读 git 观察视为当前仓库视图，较新优先；cat/head/find 等不参与。子命令后须接空白或行尾。 */
const IDEMPOTENT_BASH_RE =
  /^git(?:\s+-C\s+\S+)?\s+(?:status|diff|log|branch|show|reflog|ls-files|blame|remote -v|config --get|rev-parse)(?:\s|$)/i

function isIdempotentBashCommand(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed === '') return false
  // 复合、重定向、命令替换不是单纯的仓库视图观察，一律不判定。
  if (/[;&|<>`\n\r]/.test(trimmed) || trimmed.includes('$(')) return false
  return IDEMPOTENT_BASH_RE.test(trimmed)
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

function applyIdempotentSnapshot(
  entries: ToolResultEntry[],
  plan: Map<string, SupersessionReason>
): void {
  const groups = new Map<string, ToolResultEntry[]>()
  for (const e of entries) {
    if (e.toolName !== 'bash') continue
    // 命令参数别名与 bashTool 同源（toolArgResolver），避免手写取参漂移
    const command = resolveToolArg(e.argRecord ?? {}, 'command') ?? ''
    if (!isIdempotentBashCommand(command)) continue
    const key = normalizeCommand(command)
    const g = groups.get(key) ?? []
    g.push(e)
    groups.set(key, g)
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue
    g.sort((a, b) => a.index - b.index)
    let coverer: ToolResultEntry | undefined
    for (const e of g) if (e.success) coverer = e
    if (!coverer) continue
    for (const e of g) {
      if (e.index < coverer.index && !plan.has(e.toolCallId)) {
        plan.set(e.toolCallId, 'idempotent_snapshot')
      }
    }
  }
}

/**
 * 扫描消息序列，判定哪些 tool 结果已被更新结果覆盖。
 * 仅识别明确、安全的覆盖模式；任何不确定一律不计入。
 */
export function planToolResultSupersession(
  messages: readonly ChatMessage[]
): SupersessionPlan {
  const entries = buildToolResultEntries(messages)
  const plan = new Map<string, SupersessionReason>()
  applyExactDuplicate(entries, plan)
  applyReadRangeCovered(entries, plan)
  applyIdempotentSnapshot(entries, plan)
  return plan
}
