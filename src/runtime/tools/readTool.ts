/**
 * readTool — 生产级文件读取工具
 *
 * 异步 I/O、二进制检测（扩展名 + 解码后空字符）、文件大小预检、
 * offset/limit 分页读取、三重安全截断（字节/行数/单行）、续读提示。
 *
 * 目前不做的功能：流式读取（256KB 预检下 readFile 够用）、图片检测、PDF/Notebook（专用工具职责）。
 */
import { readFile as asyncReadFile, stat as asyncStat } from 'fs/promises'
import { extname } from 'path'
import { ToolRegistry } from './ToolRegistry'
import type { ToolExecutor, ToolContext, ToolResult } from './types'
import { readState } from './editTool'
import { decodeFileBuffer } from './editDiff'

// ── 常量 ──────────────────────────────────────────────────────────────────────

const UTF8_BOM = '\uFEFF'

const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.dylib', '.so', '.o', '.obj', '.lib', '.a',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.zst',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm',
  '.iso', '.img', '.vhd', '.vmdk',
  '.wasm', '.deb', '.rpm', '.msi',
])

/** 无分页参数时直接拒绝的文件大小阈值（256KB） */
const MAX_FILE_SIZE_WITHOUT_RANGE = 256 * 1024
/** 单次输出字节上限（100KB），超出后截断到完整行边界 */
const MAX_OUTPUT_BYTES = 100 * 1024
/** 单次输出行数上限 */
const MAX_OUTPUT_LINES = 2000
/** 单行字符上限，超出后截断并追加标记 */
const MAX_LINE_LENGTH = 1000

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 判断是否为已知二进制扩展名 */
export function isBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())
}

/** 将字节数格式化为人类可读的大小 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function stripBomForRead(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

// ── 安全截断 ──────────────────────────────────────────────────────────────────

export interface TruncationResult {
  linesText: string
  lineCount: number
  truncated: boolean
}

/**
 * 三重安全截断（顺序：单行 → 字节 → 行数）。
 * - 单行超过 1000 字符 → 截断 + "...[截断]"
 * - 字节超过 100KB → 保留完整行
 * - 行数超过 2000 → 保留前 2000 行
 */
export function applySafetyTruncation(lines: string[]): TruncationResult {
  let truncated = false
  const result: string[] = []

  // 1. 单行上限截断（1000 字符）
  for (const line of lines) {
    if (line.length > MAX_LINE_LENGTH) {
      truncated = true
      result.push(line.slice(0, MAX_LINE_LENGTH) + '...[截断]')
    } else {
      result.push(line)
    }
  }

  // 2. 字节上限截断（100KB，截断到完整行边界）
  let accumulated = 0
  let byteCutoff = result.length
  for (let i = 0; i < result.length; i++) {
    const lineBytes = Buffer.byteLength(result[i] + '\n', 'utf-8')
    if (accumulated + lineBytes > MAX_OUTPUT_BYTES) {
      byteCutoff = i
      truncated = true
      break
    }
    accumulated += lineBytes
  }
  if (byteCutoff < result.length) {
    result.length = byteCutoff
  }

  // 3. 行数上限截断（2000 行）
  if (result.length > MAX_OUTPUT_LINES) {
    truncated = true
    result.length = MAX_OUTPUT_LINES
  }

  return { linesText: result.join('\n'), lineCount: result.length, truncated }
}

/**
 * 生成续读提示。
 * 格式：[显示 X-Y 行，共 Z 行。使用 offset=Y 继续读取]
 * 仅在发生了安全截断时附加，未截断时返回空字符串。
 */
export function buildContinuationHint(
  offset: number,
  shownLineCount: number,
  totalLineCount: number,
  truncated: boolean,
): string {
  if (!truncated) return ''
  const startLine = offset + 1
  const endLine = offset + shownLineCount
  return `\n[显示 ${startLine}-${endLine} 行，共 ${totalLineCount} 行。使用 offset=${endLine} 继续读取]`
}

// ── readTool 主体 ─────────────────────────────────────────────────────────────

export const readTool: ToolExecutor = {
  name: 'read',
  description: '读取指定文件的文本内容。编辑文件前必须先读取。支持 offset/limit 分页读取长文件。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要读取的文件路径，相对于工作区根目录。',
      },
      offset: {
        type: 'number',
        description:
          '起始行号（0-indexed），跳过前 N 行。不传 limit 时从 offset 读到文件末尾。',
      },
      limit: {
        type: 'number',
        description:
          '最多读取的行数。与 offset 配合使用实现分页。',
      },
    },
    required: ['path'],
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const signal = context.abortSignal
    if (signal?.aborted) {
      return { success: false, output: '', error: '读取已取消' }
    }

    const registry = new ToolRegistry()
    const inputPath = args.path as string

    if (!inputPath) {
      return { success: false, output: '', error: '缺少 path 参数' }
    }

    const validated = registry.resolveAndValidate(context.workingDir, inputPath)
    if (!validated.ok) {
      return { success: false, output: '', error: validated.error }
    }

    const absolutePath = validated.path
    const paramOffset = Math.max(0, typeof args.offset === 'number' ? args.offset : 0)
    const rawLimit = args.limit
    const paramLimit = typeof rawLimit === 'number' && rawLimit >= 1 ? rawLimit : undefined

    try {
      if (signal?.aborted) {
        return { success: false, output: '', error: '读取已取消' }
      }

      // ── 预检：文件 stat ──
      const fileStat = await asyncStat(absolutePath)
      if (signal?.aborted) {
        return { success: false, output: '', error: '读取已取消' }
      }

      // ── 二进制扩展名检测（O(1)，在 readFile 之前避免浪费 I/O） ──
      if (isBinaryExtension(absolutePath)) {
        return {
          success: false,
          output: '',
          error: `"${inputPath}" 是二进制文件（${extname(absolutePath).toLowerCase()}），无法读取文本内容。`,
        }
      }

      // ── 文件大小预检 ──
      // 只有在无任何分页参数（offset=0 且 limit=undefined）的全量读取模式下才拒绝大文件
      if (paramLimit === undefined && paramOffset === 0 && fileStat.size > MAX_FILE_SIZE_WITHOUT_RANGE) {
        return {
          success: false,
          output: '',
          error:
            `文件过大（${formatFileSize(fileStat.size)}），请使用 offset 和 limit 参数分页读取。` +
            `当前限制为 ${Math.floor(MAX_FILE_SIZE_WITHOUT_RANGE / 1024)}KB。`,
        }
      }

      // ── 读取文件 ──
      const buf = await asyncReadFile(absolutePath)

      // ── 解码 ──
      // 空字节检测在解码后的文本字符串上做（而非原始 buffer），因为
      // UTF-16LE 等编码的原始 buffer 中合法含有空字节（高字节为 0x00）。
      const { text } = decodeFileBuffer(buf)
      if (text.includes('\0')) {
        return {
          success: false,
          output: '',
          error: `"${inputPath}" 是二进制文件（含空字节），无法读取文本内容。`,
        }
      }

      const stripped = stripBomForRead(text)
      const normalized = normalizeToLF(stripped)

      // ── 行分割与 offset/limit 切片 ──
      const allLines = normalized.split('\n')
      // 文件末尾的 `\n` 在 split 后会产生一个空串元素（如 "a\nb\n" → ['a','b','']），
      // 它不增加实际行数，但保留在数组中能让 join('\n') 重建出正确的尾部换行。
      // totalLineCount 需要排除这个空串元素，确保续读提示的 offset 定位精确。
      const totalLineCount = allLines.length > 0 && allLines[allLines.length - 1] === ''
        ? allLines.length - 1
        : allLines.length

      const slicedLines =
        paramLimit !== undefined
          ? allLines.slice(paramOffset, paramOffset + paramLimit)
          : allLines.slice(paramOffset)

      if (slicedLines.length === 0) {
        return { success: true, output: '' }
      }

      // ── 安全截断 ──
      const { linesText, lineCount: shownLineCount, truncated } =
        applySafetyTruncation(slicedLines)

      // ── 续读提示 ──
      const hint = buildContinuationHint(
        paramOffset,
        shownLineCount,
        totalLineCount,
        truncated,
      )

      // ── 写入 readState ──
      // 存储切片后、截断前的内容（即 agent 实际请求的行范围），
      // 而非全量文件内容，避免 readState 过大。
      // 截断只影响展示，不影响后续编辑校验。
      const readStateContent = slicedLines.join('\n')
      readState.set(absolutePath, {
        content: readStateContent,
        timestamp: fileStat.mtimeMs,
      })

      return { success: true, output: linesText + hint }
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException & Error
      if (nodeErr.code === 'ENOENT') {
        return { success: false, output: '', error: `文件不存在: "${inputPath}"` }
      }
      if (nodeErr.name === 'AbortError') {
        return { success: false, output: '', error: '读取已取消' }
      }
      return {
        success: false,
        output: '',
        error: `无法读取文件: ${nodeErr.message}`,
      }
    }
  },
}
