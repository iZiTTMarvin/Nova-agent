/**
 * editTool — 精确修改已有文件
 * 融合 Pi 多编辑点 + Claude Code 安全门禁 + DeepSeek 编码/回滚
 * 核心原则：所有 oldText 匹配原始文件（非增量），先读后改，写入失败自动回滚
 */
import { dirname, normalize } from 'path'
import { mkdirSync, constants } from 'fs'
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile, stat as fsStat } from 'fs/promises'
import { resolveAndValidatePath } from './ToolRegistry'
import { resolveToolArg } from './toolArgResolver'
import { metricReadStateStats } from '../../shared/diagnostics/metrics'
import type { ToolExecutor, ToolContext, ToolResult } from './types'
import { assertSideEffectAllowed } from './types'
import { withFileMutationQueue } from './file-mutation-queue'
import { decodeFileBuffer, encodeFile, type FileEncoding } from './editDiff'
import { lineDiff, renderLineDiff, computeFirstChangedLine, generateUnifiedPatch, extractSnippet } from './editDiff'

// ── EditOperations ────────────────────────────────────────────────────────────

export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>
  writeFile: (absolutePath: string, content: Buffer) => Promise<void>
  access: (absolutePath: string) => Promise<void>
  stat: (absolutePath: string) => Promise<{ mtimeMs: number; size: number }>
}

const nodeEditOperations: EditOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content),
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
  stat: async (path) => {
    const s = await fsStat(path)
    return { mtimeMs: s.mtimeMs, size: s.size }
  },
}

// ── ReadState（LRU + 字节预算）────────────────────────────────────────────────

/** 默认总字节预算（约 32MB UTF-16 近似） */
export const READ_STATE_DEFAULT_BUDGET_BYTES = 32 * 1024 * 1024
/** 单文件 content 上限（约 4MB UTF-16 近似）；超限只留元数据 */
export const READ_STATE_DEFAULT_MAX_ENTRY_BYTES = 4 * 1024 * 1024

export interface ReadStateBudgetOptions {
  /** 所有 entry content 的总字节预算（UTF-16 近似：length * 2） */
  budgetBytes?: number
  /** 单文件 content 上限；超限不保留 content，只留元数据 */
  maxEntryBytes?: number
}

/**
 * ReadState 条目。
 * content 仅在预算内保留；被淘汰或超单文件上限时为 undefined，
 * edit 命中无 content 的 entry 必须重新 read（不降低「先读后改」安全性）。
 */
export interface ReadStateEntry {
  /** 规范化路径（查找键） */
  normalizedPath: string
  /** 读取时的 mtimeMs */
  timestamp: number
  /** 文件字节大小（stat.size）；未知时为 content 的 UTF-8 近似 */
  size: number
  /** 内容哈希（用于外部修改检测的轻量指纹） */
  contentHash: string
  /** 全文；预算外或被 LRU 淘汰后为 undefined */
  content?: string
}

/** 对外暴露的缓存统计 */
export interface ReadStateStats {
  entries: number
  bytes: number
  evictions: number
  hits: number
  misses: number
  hitRate: number
}

export interface ReadState {
  get(path: string): ReadStateEntry | undefined
  set(path: string, entry: ReadStateEntry | { content: string; timestamp: number; size?: number }): void
  has(path: string): boolean
  clear(): void
  /** 深拷贝：用于 sub agent 创建独立 readState，避免污染父 agent */
  clone(): ReadState
  /** 当前统计（entries / bytes / evictions / hitRate） */
  getStats(): ReadStateStats
}

/**
 * 规范化 readState 的 key。
 *
 * readState 以「已读文件的绝对路径字符串」为键：readTool 写入、editTool 校验、
 * writeTool 回种。同一个物理文件在不同调用里可能产生不同的字符串形式：
 *   - 路径分隔符差异（Windows 上 `/` 与 `\`）；
 *   - 盘符 / 路径大小写差异（`D:\` 与 `d:\`、`Style.css` 与 `style.css`）——
 *     Windows 文件系统大小写不敏感，但 JS Map 的键是大小写敏感的字符串比较。
 *
 * 一旦 read 写入的 key 与 edit 查询的 key 大小写/分隔符不一致，safetyGate 会误判
 * "File has not been read yet"，从而触发模型反复 read → edit → 失败 → read 的死循环
 * （这正是 Windows 上观测到的严重 bug 的根因）。
 *
 * 这里统一规范化：先用 path.normalize 折叠分隔符与冗余段，再在大小写不敏感的
 * 平台（win32）上转为小写。Linux 文件系统区分大小写，保持原样以免误合并不同文件。
 *
 * 注意：仅规范化「Map 的查找键」，真正用于文件 I/O 的路径仍使用原始 absolutePath。
 */
function normalizeReadStateKey(path: string): string {
  const normalized = normalize(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 近似 UTF-16 字节占用 */
function contentByteSize(content: string | undefined): number {
  return content ? content.length * 2 : 0
}

/** 轻量内容指纹（不引入 crypto 依赖到热路径的大开销；FNV-1a 64 截断） */
export function hashReadContent(content: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * LRU + 总字节预算 + 单文件上限的 ReadState 实现。
 * Map 插入序模拟 LRU：get/set 时 delete+reinsert 移到末尾；淘汰从头部开始。
 */
class ReadStateMap implements ReadState {
  private store = new Map<string, ReadStateEntry>()
  private totalBytes = 0
  private evictions = 0
  private hits = 0
  private misses = 0
  private readonly budgetBytes: number
  private readonly maxEntryBytes: number

  constructor(opts?: ReadStateBudgetOptions) {
    this.budgetBytes = opts?.budgetBytes ?? READ_STATE_DEFAULT_BUDGET_BYTES
    this.maxEntryBytes = opts?.maxEntryBytes ?? READ_STATE_DEFAULT_MAX_ENTRY_BYTES
  }

  get(path: string): ReadStateEntry | undefined {
    const key = normalizeReadStateKey(path)
    const entry = this.store.get(key)
    if (!entry) {
      this.misses++
      return undefined
    }
    // 无 content 的元数据条目对 edit 无效 → 视为 miss（要求重新 read）
    if (entry.content === undefined) {
      this.misses++
      return undefined
    }
    this.hits++
    // LRU：移到末尾
    this.store.delete(key)
    this.store.set(key, entry)
    return entry
  }

  set(
    path: string,
    raw: ReadStateEntry | { content: string; timestamp: number; size?: number }
  ): void {
    const key = normalizeReadStateKey(path)
    const content = 'content' in raw ? raw.content : undefined
    const timestamp = raw.timestamp
    const size =
      'size' in raw && typeof raw.size === 'number'
        ? raw.size
        : content !== undefined
          ? Buffer.byteLength(content, 'utf8')
          : 0
    const contentHash =
      'contentHash' in raw && typeof (raw as ReadStateEntry).contentHash === 'string'
        ? (raw as ReadStateEntry).contentHash
        : content !== undefined
          ? hashReadContent(content)
          : ''

    let keepContent = content
    let bytes = contentByteSize(keepContent)
    // 单文件超限：只留元数据，不占预算
    if (bytes > this.maxEntryBytes) {
      keepContent = undefined
      bytes = 0
    }

    const prev = this.store.get(key)
    if (prev) {
      this.totalBytes -= contentByteSize(prev.content)
      this.store.delete(key)
    }

    const entry: ReadStateEntry = {
      normalizedPath: key,
      timestamp,
      size,
      contentHash,
      ...(keepContent !== undefined ? { content: keepContent } : {})
    }
    this.store.set(key, entry)
    this.totalBytes += bytes
    this.evictUntilWithinBudget()
    this.emitStats()
  }

  has(path: string): boolean {
    const entry = this.store.get(normalizeReadStateKey(path))
    // 与 get 一致：无 content 视为未读
    return entry !== undefined && entry.content !== undefined
  }

  clear(): void {
    this.store.clear()
    this.totalBytes = 0
    this.emitStats()
  }

  clone(): ReadState {
    const copy = new ReadStateMap({
      budgetBytes: this.budgetBytes,
      maxEntryBytes: this.maxEntryBytes
    })
    for (const [key, value] of this.store) {
      copy.store.set(key, { ...value })
      copy.totalBytes += contentByteSize(value.content)
    }
    copy.evictions = this.evictions
    copy.hits = this.hits
    copy.misses = this.misses
    return copy
  }

  getStats(): ReadStateStats {
    const total = this.hits + this.misses
    return {
      entries: this.store.size,
      bytes: this.totalBytes,
      evictions: this.evictions,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total
    }
  }

  /** 超出总预算时从 LRU 头部淘汰 content（保留元数据或整条删除以释放） */
  private evictUntilWithinBudget(): void {
    while (this.totalBytes > this.budgetBytes && this.store.size > 0) {
      const oldestKey = this.store.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      const oldest = this.store.get(oldestKey)
      if (!oldest) {
        this.store.delete(oldestKey)
        continue
      }
      const bytes = contentByteSize(oldest.content)
      if (bytes > 0 && oldest.content !== undefined) {
        // 先剥 content，保留元数据供诊断；下次 get 仍视为 miss
        this.totalBytes -= bytes
        this.store.set(oldestKey, { ...oldest, content: undefined })
        // 移到头部以外：delete 再插到当前（已是被访问？）——保持淘汰序：删掉再插到开头较难，
        // 简单策略：整条删除，强制重新 read
        this.store.delete(oldestKey)
        this.evictions++
      } else {
        this.store.delete(oldestKey)
        this.evictions++
      }
    }
  }

  private emitStats(): void {
    const s = this.getStats()
    metricReadStateStats(s.entries, s.bytes, s.evictions)
  }
}

/** 工厂：创建独立的 readState 实例（每个 AgentLoop 一个，sub agent 通过 clone 隔离） */
export function createReadState(opts?: ReadStateBudgetOptions): ReadState {
  return new ReadStateMap(opts)
}

// ── lineEnding ────────────────────────────────────────────────────────────────

const UTF8_BOM = '\uFEFF'

export function stripBom(text: string): { bom: string; text: string } {
  if (text.startsWith(UTF8_BOM)) {
    return { bom: UTF8_BOM, text: text.slice(1) }
  }
  return { bom: '', text }
}

export function detectLineEnding(text: string): 'CRLF' | 'LF' {
  return text.includes('\r\n') ? 'CRLF' : 'LF'
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

export function restoreLineEndings(text: string, ending: 'CRLF' | 'LF'): string {
  if (ending === 'CRLF') {
    return text.replace(/\n/g, '\r\n')
  }
  return text
}

// ── quoteNormalizer ───────────────────────────────────────────────────────────

const DOUBLE_CURLY_TO_STRAIGHT: Record<string, string> = {
  '\u201C': '"',
  '\u201D': '"',
}

const SINGLE_CURLY_TO_STRAIGHT: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
}

export function normalizeQuotes(text: string): string {
  let result = ''
  for (const ch of text) {
    result += DOUBLE_CURLY_TO_STRAIGHT[ch] ?? SINGLE_CURLY_TO_STRAIGHT[ch] ?? ch
  }
  return result
}

export function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) return searchString

  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)
  const idx = normalizedFile.indexOf(normalizedSearch)
  if (idx === -1) return null

  return fileContent.substring(idx, idx + searchString.length)
}

function applyCurlyDoubleQuotes(text: string): string {
  let result = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '"') {
      result += ch
      continue
    }
    const prev = i > 0 ? text[i - 1] : ''
    const isClosing = prev && /[\w\p{L}]/u.test(prev)
    result += isClosing ? '\u201D' : '\u201C'
  }
  return result
}

function applyCurlySingleQuotes(text: string): string {
  let result = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== "'") {
      result += ch
      continue
    }
    const prev = i > 0 ? text[i - 1] : ''
    const next = i + 1 < text.length ? text[i + 1] : ''
    const prevIsLetter = prev && /[\w\p{L}]/u.test(prev)
    const nextIsLetter = next && /[\w\p{L}]/u.test(next)
    if (prevIsLetter && nextIsLetter) {
      result += "'"
    } else {
      const isClosing = prevIsLetter
      result += isClosing ? '\u2019' : '\u2018'
    }
  }
  return result
}

export function preserveQuoteStyle(modelOld: string, actualOld: string, modelNew: string): string {
  if (modelOld === actualOld) return modelNew

  const hasCurlyDouble = /[\u201C\u201D]/.test(actualOld)
  const hasCurlySingle = /[\u2018\u2019]/.test(actualOld)

  let result = modelNew
  if (hasCurlyDouble) {
    result = applyCurlyDoubleQuotes(result)
  }
  if (hasCurlySingle) {
    result = applyCurlySingleQuotes(result)
  }
  return result
}

// ── desanitizeMatch ───────────────────────────────────────────────────────────

const DESANITIZATIONS: Array<[string, string]> = [
  ['<fnr>', '<function_results>'],
  ['</fnr>', '</function_results>'],
  ['<n>', '<name>'],
  ['</n>', '</name>'],
  ['<o>', '<output>'],
  ['</o>', '</output>'],
  ['<e>', '<error>'],
  ['</e>', '</error>'],
  ['<s>', '<system>'],
  ['</s>', '</system>'],
  ['<r>', '<result>'],
  ['</r>', '</result>'],
  ['< META_START >', '<META_START>'],
  ['< META_END >', '</META_END>'],
  ['< EOT >', '<EOT>'],
  ['< META >', '<META>'],
  ['< SOS >', '<SOS>'],
  ['\n\nH:', '\n\nHuman:'],
  ['\n\nA:', '\n\nAssistant:'],
]

export function desanitizeMatchString(sanitized: string): {
  result: string
  applied: Array<{ from: string; to: string }>
} {
  let result = sanitized
  const applied: Array<{ from: string; to: string }> = []

  for (const [from, to] of DESANITIZATIONS) {
    if (result.includes(from)) {
      result = result.replaceAll(from, to)
      applied.push({ from, to })
    }
  }

  return { result, applied }
}

export function applyCorrespondingDesanitization(
  newText: string,
  oldText: string,
  desanitizedOld: string,
): string {
  if (oldText === desanitizedOld) return newText

  let result = newText
  for (const [sanitized, original] of DESANITIZATIONS) {
    if (oldText.includes(sanitized) && desanitizedOld.includes(original)) {
      result = result.replaceAll(sanitized, original)
    }
  }
  return result
}

// ── resolveEdits ──────────────────────────────────────────────────────────────

export interface ResolvedEdit {
  index: number
  originalOldText: string
  actualOldText: string
  actualNewText: string
  startOffset: number
}

function countOccurrences(text: string, search: string): number {
  if (search.length === 0) return 0
  let count = 0
  let pos = 0
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}

function checkNoOverlapping(resolved: ResolvedEdit[]): void {
  const sorted = [...resolved].sort((a, b) => a.startOffset - b.startOffset)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const curr = sorted[i]
    const prevEnd = prev.startOffset + prev.actualOldText.length
    if (curr.startOffset < prevEnd) {
      throw new Error(
        `Edits #${prev.index + 1} and #${curr.index + 1} overlap. Merge them into one edit.`
      )
    }
  }
}

export function resolveEdits(
  original: string,
  edits: Array<{ oldText: string; newText: string }>,
  path: string,
): ResolvedEdit[] {
  const resolved: ResolvedEdit[] = []

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]
    let actualOldText: string | null = null
    let actualNewText = edit.newText

    if (original.includes(edit.oldText)) {
      actualOldText = edit.oldText
    }

    if (actualOldText === null) {
      const found = findActualString(original, edit.oldText)
      if (found !== null) {
        actualOldText = found
        actualNewText = preserveQuoteStyle(edit.oldText, found, edit.newText)
      }
    }

    if (actualOldText === null) {
      const { result: desanitized, applied } = desanitizeMatchString(edit.oldText)
      if (applied.length > 0 && original.includes(desanitized)) {
        actualOldText = desanitized
        actualNewText = applyCorrespondingDesanitization(edit.newText, edit.oldText, desanitized)
      }
    }

    if (actualOldText === null) {
      const preview = edit.oldText.length > 80
        ? edit.oldText.slice(0, 80) + '...'
        : edit.oldText
      throw new Error(
        `Edit #${i + 1}: oldText not found in "${path}". Searched for: "${preview}"`
      )
    }

    const occurrences = countOccurrences(original, actualOldText)
    if (occurrences > 1) {
      throw new Error(
        `Edit #${i + 1}: oldText appears ${occurrences} times in "${path}". Include more context to make it unique.`
      )
    }

    resolved.push({
      index: i,
      originalOldText: edit.oldText,
      actualOldText,
      actualNewText,
      startOffset: original.indexOf(actualOldText),
    })
  }

  checkNoOverlapping(resolved)

  return resolved
}

// ── editTool 主体 ─────────────────────────────────────────────────────────────

interface ReadForEditResult {
  originalBuffer: Buffer
  encoding: FileEncoding
  bom: string
  lineEnding: 'CRLF' | 'LF'
  normalized: string
}

const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024

async function readFileForEdit(ops: EditOperations, path: string): Promise<ReadForEditResult> {
  const buf = await ops.readFile(path)
  const { text, encoding } = decodeFileBuffer(buf)
  const { bom, text: stripped } = stripBom(text)
  const lineEnding = detectLineEnding(stripped)
  const normalized = normalizeToLF(stripped)
  return { originalBuffer: buf, encoding, bom, lineEnding, normalized }
}

async function safetyGate(
  path: string,
  rs: ReadState,
  ops: EditOperations,
  currentNormalizedContent: string,
): Promise<void> {
  const lastRead = rs.get(path)
  // get() 在 content 被淘汰时返回 undefined → 要求重新 read
  if (!lastRead || lastRead.content === undefined) {
    throw new Error(
      `File has not been read yet. Use the read tool first to read "${path}" before editing.`
    )
  }

  let stat: { mtimeMs: number; size: number }
  try {
    stat = await ops.stat(path)
  } catch {
    throw new Error(`File "${path}" no longer exists. Read it again to confirm.`)
  }

  if (stat.mtimeMs > lastRead.timestamp) {
    if (currentNormalizedContent !== lastRead.content) {
      throw new Error(
        `File "${path}" was modified externally after your last read. Read it again before editing.`
      )
    }
  }

  if (stat.size > MAX_EDIT_FILE_SIZE) {
    throw new Error(
      `File is too large to edit (${stat.size} bytes). Maximum is ${MAX_EDIT_FILE_SIZE} bytes.`
    )
  }
}

function normalizeInput(args: Record<string, unknown>): {
  filePath: string
  edits: Array<{ oldText: string; newText: string }>
} {
  const filePath = resolveToolArg(args, 'path') ?? ''

  if (!args.edits && typeof args.old === 'string' && typeof args.new === 'string') {
    return { filePath, edits: [{ oldText: args.old, newText: args.new }] }
  }

  let edits = args.edits
  if (typeof edits === 'string') {
    try { edits = JSON.parse(edits) } catch { /* keep as-is, validation will catch */ }
  }

  return { filePath, edits: edits as Array<{ oldText: string; newText: string }> }
}

function applyResolvedEdits(original: string, resolved: ResolvedEdit[]): string {
  const sorted = [...resolved].sort((a, b) => b.startOffset - a.startOffset)
  let result = original
  for (const edit of sorted) {
    result = result.substring(0, edit.startOffset) +
      edit.actualNewText +
      result.substring(edit.startOffset + edit.actualOldText.length)
  }
  return result
}

async function safeWrite(
  ops: EditOperations,
  path: string,
  newContent: string,
  readResult: ReadForEditResult,
): Promise<void> {
  const restored = restoreLineEndings(newContent, readResult.lineEnding)
  const finalBuffer = encodeFile(restored, readResult.encoding)

  try {
    mkdirSync(dirname(path), { recursive: true })
    await ops.writeFile(path, finalBuffer)
  } catch (writeErr) {
    try {
      const originalRestored = restoreLineEndings(readResult.normalized, readResult.lineEnding)
      const originalBuffer = encodeFile(originalRestored, readResult.encoding)
      await ops.writeFile(path, originalBuffer)
    } catch (rollbackErr) {
      throw new Error(
        `Write failed: ${(writeErr as Error).message}. Rollback also failed: ${(rollbackErr as Error).message}. File may be inconsistent.`
      )
    }
    throw new Error(
      `Write failed, file restored to original. Original error: ${(writeErr as Error).message}`
    )
  }
}

export const editTool: ToolExecutor = {
  name: 'edit',
  description:
    '精确修改已有文件。支持一次调用修改多处（edits 数组）。' +
    '所有 oldText 与原始文件匹配（非增量），必须唯一且互不重叠。' +
    '编辑前必须先用 read 工具读取文件。',
  executionMode: 'sequential',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: '要修改的文件路径（绝对或相对工作区）。'
      },
      edits: {
        type: 'array',
        minItems: 1,
        description:
          '一个或多个精确替换。每个 oldText 匹配原始文件（非增量），必须唯一。' +
          '如果两处修改在同一块或相邻行，合并为一个 edit。',
        items: {
          type: 'object',
          properties: {
            oldText: {
              type: 'string',
              description: '原始文件中要查找的精确文本，必须唯一。'
            },
            newText: {
              type: 'string',
              description: '替换后的新文本。'
            },
          },
          required: ['oldText', 'newText'],
        },
      },
      path: {
        type: 'string',
        description: '（兼容旧格式）文件路径。'
      },
      old: {
        type: 'string',
        description: '（兼容旧格式）要被替换的原始文本。'
      },
      new: {
        type: 'string',
        description: '（兼容旧格式）替换后的新文本。'
      },
    },
    required: ['filePath'],
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const signal = context.abortSignal
    const throwIfAborted = () => {
      if (signal?.aborted) throw new Error('Edit operation aborted')
    }

    const ops = nodeEditOperations

    let input: { filePath: string; edits: Array<{ oldText: string; newText: string }> }
    try {
      input = normalizeInput(args)
    } catch {
      return { success: false, output: '', error: '参数格式错误' }
    }

    if (!input.filePath) {
      const hasLegacy = typeof args.old === 'string' || typeof args.new === 'string'
      const hint = hasLegacy
        ? '缺少 filePath 参数（已收到 old/new，请同时提供 filePath 或 path）'
        : '缺少 filePath 参数'
      return { success: false, output: '', error: hint }
    }
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      return { success: false, output: '', error: '缺少 edits 参数（或旧格式 old/new）' }
    }

    const validated = resolveAndValidatePath(context.workingDir, input.filePath)
    if (!validated.ok) {
      return { success: false, output: '', error: validated.error }
    }
    const absolutePath = validated.path

    try {
      return await withFileMutationQueue(absolutePath, async () => {
        // 副作用入口：abort + generation fencing（假终止后禁止写盘）
        assertSideEffectAllowed(context, 'edit')
        throwIfAborted()

        await ops.access(absolutePath)
        throwIfAborted()

        const readResult = await readFileForEdit(ops, absolutePath)
        throwIfAborted()

        await safetyGate(absolutePath, context.readState, ops, readResult.normalized)
        throwIfAborted()

        const resolved = resolveEdits(readResult.normalized, input.edits, absolutePath)
        throwIfAborted()

        const newContent = applyResolvedEdits(readResult.normalized, resolved)
        throwIfAborted()

        if (context.checkpointManager) {
          assertSideEffectAllowed(context, 'checkpoint backup')
          context.checkpointManager.backupBeforeWrite(absolutePath, false)
        }
        const effectToken = context.fileEffectRecorder?.prepareFileWrite(absolutePath, 'modify')

        await safeWrite(ops, absolutePath, newContent, readResult)
        throwIfAborted()
        if (effectToken) {
          context.fileEffectRecorder!.commitFileWrite(effectToken, absolutePath)
        }

        const newStat = await ops.stat(absolutePath)
        context.readState.set(absolutePath, {
          content: newContent,
          timestamp: newStat.mtimeMs,
          size: newStat.size
        })

        const diff = lineDiff(readResult.normalized, newContent)
        const diffStr = renderLineDiff(diff)
        const patch = generateUnifiedPatch(input.filePath, readResult.normalized, newContent)
        const firstChangedLine = computeFirstChangedLine(readResult.normalized, newContent)
        const snippet = extractSnippet(newContent, resolved)

        const parts: string[] = [
          `已修改 "${input.filePath}"，替换了 ${resolved.length} 处。首个变更行: ${firstChangedLine}`,
          '',
          diffStr,
        ]
        if (patch) {
          parts.push('', '--- patch ---', patch)
        }
        if (snippet) {
          parts.push('', '--- snippet ---', snippet)
        }

        return {
          success: true,
          output: parts.join('\n'),
        }
      })
    } catch (err) {
      const msg = (err as Error).message
      return { success: false, output: '', error: msg }
    }
  }
}
