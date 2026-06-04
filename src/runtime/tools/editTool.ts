/**
 * editTool — 精确修改已有文件
 * 融合 Pi 多编辑点 + Claude Code 安全门禁 + DeepSeek 编码/回滚
 * 核心原则：所有 oldText 匹配原始文件（非增量），先读后改，写入失败自动回滚
 */
import { dirname } from 'path'
import { mkdirSync, constants } from 'fs'
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile, stat as fsStat } from 'fs/promises'
import { ToolRegistry } from './ToolRegistry'
import type { ToolExecutor, ToolContext, ToolResult } from './types'
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

// ── fileMutationQueue ─────────────────────────────────────────────────────────

const queues = new Map<string, Promise<void>>()

export async function withFileMutationQueue<T>(
  absolutePath: string,
  callback: () => Promise<T>
): Promise<T> {
  const prev = queues.get(absolutePath) ?? Promise.resolve()
  const next = prev.then(callback, callback)
  queues.set(absolutePath, next.then(() => {}, () => {}))
  return next
}

// ── ReadState ─────────────────────────────────────────────────────────────────

export interface ReadStateEntry {
  content: string
  timestamp: number
}

export interface ReadState {
  get(path: string): ReadStateEntry | undefined
  set(path: string, entry: ReadStateEntry): void
  has(path: string): boolean
  clear(): void
}

class ReadStateMap implements ReadState {
  private store = new Map<string, ReadStateEntry>()
  get(path: string): ReadStateEntry | undefined { return this.store.get(path) }
  set(path: string, entry: ReadStateEntry): void { this.store.set(path, entry) }
  has(path: string): boolean { return this.store.has(path) }
  clear(): void { this.store.clear() }
}

export const readState: ReadState = new ReadStateMap()

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
  if (!lastRead) {
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
  const filePath = (args.filePath ?? args.path ?? args.file_path) as string

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
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const signal = context.abortSignal
    const throwIfAborted = () => {
      if (signal?.aborted) throw new Error('Edit operation aborted')
    }

    const registry = new ToolRegistry()
    const ops = nodeEditOperations

    let input: { filePath: string; edits: Array<{ oldText: string; newText: string }> }
    try {
      input = normalizeInput(args)
    } catch {
      return { success: false, output: '', error: '参数格式错误' }
    }

    if (!input.filePath) {
      return { success: false, output: '', error: '缺少 filePath 参数' }
    }
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      return { success: false, output: '', error: '缺少 edits 参数（或旧格式 old/new）' }
    }

    const validated = registry.resolveAndValidate(context.workingDir, input.filePath)
    if (!validated.ok) {
      return { success: false, output: '', error: validated.error }
    }
    const absolutePath = validated.path

    try {
      return await withFileMutationQueue(absolutePath, async () => {
        throwIfAborted()

        await ops.access(absolutePath)
        throwIfAborted()

        const readResult = await readFileForEdit(ops, absolutePath)
        throwIfAborted()

        await safetyGate(absolutePath, readState, ops, readResult.normalized)
        throwIfAborted()

        const resolved = resolveEdits(readResult.normalized, input.edits, absolutePath)
        throwIfAborted()

        const newContent = applyResolvedEdits(readResult.normalized, resolved)
        throwIfAborted()

        if (context.checkpointManager) {
          context.checkpointManager.backupBeforeWrite(absolutePath, false)
        }

        await safeWrite(ops, absolutePath, newContent, readResult)
        throwIfAborted()

        const newStat = await ops.stat(absolutePath)
        readState.set(absolutePath, {
          content: newContent,
          timestamp: newStat.mtimeMs,
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
