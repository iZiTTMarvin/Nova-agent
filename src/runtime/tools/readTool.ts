/**
 * readTool — 生产级文件读取工具
 *
 * 异步 I/O、图片检测（文件头签名 MIME 检测）、二进制检测（扩展名 + 解码后空字符）、
 * 文件大小预检、offset/limit 分页读取、三重安全截断（字节/行数/单行）、续读提示。
 *
 * 图片处理：检测到图片时读取二进制 → base64 编码 → 通过 ToolResult.images 返回，
 * AgentLoop 负责组合为多模态消息发送给模型。
 */
import { readFile as asyncReadFile, stat as asyncStat } from 'fs/promises'
import { extname } from 'path'
import { resolveAndValidatePath } from './ToolRegistry'
import type { ToolExecutor, ToolContext, ToolResult } from './types'
import { decodeFileBuffer } from './editDiff'
import { detectImageMimeTypeFromFile } from './mime'
import { resizeImage, formatDimensionNote } from './image-resize'
import { OutputSink } from './OutputSink'
import {
  isSummarizableExtension,
  summarizeStructure,
  MIN_SUMMARY_LINES,
} from './readSummarizer'

// ── 常量 ──────────────────────────────────────────────────────────────────────

const UTF8_BOM = '\uFEFF'

const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.dylib', '.so', '.o', '.obj', '.lib', '.a',
  '.bmp', '.ico', '.avif',
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
/** 支持读取的图片扩展名（走 MIME 检测路径，不走二进制拒绝路径） */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
/** artifact 虚拟路径前缀，用于续读 bash/grep 等大输出 */
const ARTIFACT_PATH_PREFIX = 'artifact://'

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 判断是否为已知二进制扩展名。可传入预计算的 ext 避免重复调用 extname */
export function isBinaryExtension(filePathOrExt: string): boolean {
  const ext = filePathOrExt.startsWith('.') ? filePathOrExt : extname(filePathOrExt).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
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

/** 从 path 参数解析 artifact ID；非 artifact 路径返回 null */
function parseArtifactId(inputPath: string): string | null {
  if (!inputPath.startsWith(ARTIFACT_PATH_PREFIX)) return null
  const id = inputPath.slice(ARTIFACT_PATH_PREFIX.length).trim()
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) return null
  return id
}

/**
 * 安全截断后可选走 OutputSink 二次控量（需 artifactStore）。
 * 返回 workspace 标头 + 正文，以及可能的 artifactId / truncationMeta。
 */
async function buildReadToolResult(
  bodyText: string,
  context: ToolContext
): Promise<ToolResult> {
  let outputBody = bodyText
  let artifactId: string | undefined
  let truncationMeta: ToolResult['truncationMeta']

  if (context.artifactStore && context.sessionId) {
    const sink = new OutputSink({
      artifactStore: context.artifactStore,
      sessionId: context.sessionId,
      toolName: 'read'
    })
    const finalized = await sink.finalize(bodyText)
    outputBody = finalized.contextText
    if (finalized.artifactId) {
      artifactId = finalized.artifactId
      truncationMeta = finalized.truncationMeta
    }
  }

  return {
    success: true,
    output: `[workspace: ${context.workingDir}]\n${outputBody}`,
    ...(artifactId ? { artifactId } : {}),
    ...(truncationMeta ? { truncationMeta } : {})
  }
}

/** 统计 split 后的有效总行数（排除尾部空串元素） */
function countEffectiveLines(allLines: string[]): number {
  return allLines.length > 0 && allLines[allLines.length - 1] === ''
    ? allLines.length - 1
    : allLines.length
}

/**
 * 对文本行数组做 offset/limit 切片、安全截断、续读提示，并写入 readState。
 * readState 始终保存切片后、截断前的真实内容（供 edit 校验）。
 */
async function processTextLines(
  allLines: string[],
  paramOffset: number,
  paramLimit: number | undefined,
  readStateKey: string,
  readStateTimestamp: number,
  context: ToolContext
): Promise<ToolResult> {
  const totalLineCount = countEffectiveLines(allLines)

  const slicedLines =
    paramLimit !== undefined
      ? allLines.slice(paramOffset, paramOffset + paramLimit)
      : allLines.slice(paramOffset)

  if (slicedLines.length === 0) {
    return { success: true, output: `[workspace: ${context.workingDir}]\n` }
  }

  const { linesText, lineCount: shownLineCount, truncated } =
    applySafetyTruncation(slicedLines)

  const hint = buildContinuationHint(
    paramOffset,
    shownLineCount,
    totalLineCount,
    truncated
  )

  // readState 保存真实切片（截断前），不影响 edit 工具的"先读后改"校验
  const readStateContent = slicedLines.join('\n')
  context.readState.set(readStateKey, {
    content: readStateContent,
    timestamp: readStateTimestamp
  })

  return buildReadToolResult(`${linesText}${hint}`, context)
}

/**
 * 判断是否应走结构化摘要路径：
 * 支持扩展名 + 无 offset/limit +（文件 > 256KB 或行数 ≥ 400）。
 */
function shouldUseStructureSummary(
  ext: string,
  paramOffset: number,
  paramLimit: number | undefined,
  fileSize: number,
  lineCount: number
): boolean {
  if (paramLimit !== undefined || paramOffset > 0) return false
  if (!isSummarizableExtension(ext)) return false
  return fileSize > MAX_FILE_SIZE_WITHOUT_RANGE || lineCount >= MIN_SUMMARY_LINES
}

/**
 * 结构化摘要路径：readState 保存全文，output 首行标注 structure-summary。
 */
async function processStructureSummary(
  normalized: string,
  absolutePath: string,
  fileStatMtime: number,
  context: ToolContext
): Promise<ToolResult | null> {
  const summary = summarizeStructure(absolutePath, normalized)
  if (!summary) return null

  // readState 保存真实全文（非摘要），供 edit 工具"先读后改"校验
  context.readState.set(absolutePath, {
    content: normalized,
    timestamp: fileStatMtime
  })

  const body = `[read mode: structure-summary]\n${summary}`
  return buildReadToolResult(body, context)
}

/** 读取 artifact://{id} 片段（续读 bash/grep 等大输出） */
async function readFromArtifact(
  artifactId: string,
  paramOffset: number,
  paramLimit: number | undefined,
  context: ToolContext
): Promise<ToolResult> {
  if (!context.artifactStore || !context.sessionId) {
    return {
      success: false,
      output: '',
      error: '无法读取 artifact：当前会话未启用 artifactStore'
    }
  }

  try {
    const raw = await context.artifactStore.read(context.sessionId, artifactId)
    const normalized = normalizeToLF(raw)
    const allLines = normalized.split('\n')
    const readStateKey = `${ARTIFACT_PATH_PREFIX}${artifactId}`

    return processTextLines(
      allLines,
      paramOffset,
      paramLimit,
      readStateKey,
      Date.now(),
      context
    )
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === 'ENOENT') {
      return {
        success: false,
        output: '',
        error: `artifact 不存在: "${ARTIFACT_PATH_PREFIX}${artifactId}"`
      }
    }
    return {
      success: false,
      output: '',
      error: `无法读取 artifact: ${(err as Error).message}`
    }
  }
}

// ── readTool 主体 ─────────────────────────────────────────────────────────────

export const readTool: ToolExecutor = {
  name: 'read',
  description: '读取指定文件的内容。支持文本文件和图片（jpg、png、gif、webp）。图片以 base64 编码发送给模型。编辑文件前必须先读取。支持 offset/limit 分页读取长文件。',
  executionMode: 'parallel',
  isConcurrencySafe: () => true,
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要读取的文件路径，相对于工作区根目录（绝对路径见 session context）。',
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

    const inputPath = args.path as string

    if (!inputPath) {
      return { success: false, output: '', error: '缺少 path 参数' }
    }

    const paramOffset = Math.max(0, typeof args.offset === 'number' ? args.offset : 0)
    const rawLimit = args.limit
    const paramLimit = typeof rawLimit === 'number' && rawLimit >= 1 ? rawLimit : undefined

    // artifact:// 续读路径：不走工作区路径校验
    const artifactId = parseArtifactId(inputPath)
    if (artifactId) {
      return readFromArtifact(artifactId, paramOffset, paramLimit, context)
    }

    const validated = resolveAndValidatePath(context.workingDir, inputPath)
    if (!validated.ok) {
      return { success: false, output: '', error: validated.error }
    }

    const absolutePath = validated.path

    try {
      if (signal?.aborted) {
        return { success: false, output: '', error: '读取已取消' }
      }

      // ── 预检：文件 stat ──
      const fileStat = await asyncStat(absolutePath)
      if (signal?.aborted) {
        return { success: false, output: '', error: '读取已取消' }
      }

      // ── 图片 MIME 检测（基于文件头签名，优先于二进制扩展名检测） ──
      // 只有图片扩展名才走 MIME 检测，避免对每个文件都读头部
      const ext = extname(absolutePath).toLowerCase()
      if (IMAGE_EXTENSIONS.has(ext)) {
        const mimeType = await detectImageMimeTypeFromFile(absolutePath)
        if (mimeType) {
          if (signal?.aborted) {
            return { success: false, output: '', error: '读取已取消' }
          }

          // 模型不支持 vision 时，给出明确提示而非让 API 报 raw error
          if (!context.supportsVision) {
            return {
              success: true,
              output: `已检测到图片文件 [${mimeType}]，但当前模型不支持图片输入，图片内容已省略。`,
            }
          }

          const imageBuf = await asyncReadFile(absolutePath)

          // 尝试缩放图片到合理尺寸（2000×2000、4.5MB base64 上限、EXIF 自动修正）
          const resized = await resizeImage(imageBuf, mimeType)
          if (!resized) {
            return {
              success: true,
              output: `已读取图片文件 [${mimeType}]，尺寸 ${formatFileSize(imageBuf.length)}。\n[图片因无法缩放到合理大小而被省略。]`,
            }
          }

          // 构建输出提示：MIME 类型 + 维度映射说明
          let textNote = `已读取图片文件 [${resized.mimeType}]`
          const dimensionNote = formatDimensionNote(resized)
          if (dimensionNote) textNote += `\n${dimensionNote}`

          return {
            success: true,
            output: textNote,
            images: [{ data: resized.data, mimeType: resized.mimeType }],
          }
        }
        // MIME 检测失败（可能损坏或不支持），按二进制文件处理
        return {
          success: false,
          output: '',
          error: `"${inputPath}" 无法识别为有效图片文件。`,
        }
      }

      // ── 二进制扩展名检测（O(1)，复用上方已计算的 ext） ──
      if (isBinaryExtension(ext)) {
        return {
          success: false,
          output: '',
          error: `"${inputPath}" 是二进制文件（${extname(absolutePath).toLowerCase()}），无法读取文本内容。`,
        }
      }

      // ── 文件大小预检 ──
      // 摘要路径：在拒绝大文件之前尝试结构化摘要（任务 12）
      // 非摘要候选仍走原有「无分页则拒绝 >256KB」逻辑
      const needsFullReadForSummary =
        isSummarizableExtension(ext) &&
        paramLimit === undefined &&
        paramOffset === 0

      if (
        !needsFullReadForSummary &&
        paramLimit === undefined &&
        paramOffset === 0 &&
        fileStat.size > MAX_FILE_SIZE_WITHOUT_RANGE
      ) {
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
      const allLines = normalized.split('\n')
      const lineCount = countEffectiveLines(allLines)

      // ── 结构化摘要路径 ──
      if (shouldUseStructureSummary(ext, paramOffset, paramLimit, fileStat.size, lineCount)) {
        const summaryResult = await processStructureSummary(
          normalized,
          absolutePath,
          fileStat.mtimeMs,
          context
        )
        if (summaryResult) return summaryResult
      }

      // 摘要不适用时，对大文件且无分页参数仍拒绝
      if (paramLimit === undefined && paramOffset === 0 && fileStat.size > MAX_FILE_SIZE_WITHOUT_RANGE) {
        return {
          success: false,
          output: '',
          error:
            `文件过大（${formatFileSize(fileStat.size)}），请使用 offset 和 limit 参数分页读取。` +
            `当前限制为 ${Math.floor(MAX_FILE_SIZE_WITHOUT_RANGE / 1024)}KB。`,
        }
      }

      return processTextLines(
        allLines,
        paramOffset,
        paramLimit,
        absolutePath,
        fileStat.mtimeMs,
        context
      )
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
