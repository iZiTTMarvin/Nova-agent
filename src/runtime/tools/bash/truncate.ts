/**
 * truncate.ts — head/tail 双模式截断算法
 *
 * 这套算法只关心"给定一段字符串，按行数和字节数两个维度裁剪到限制内"，
 * 不关心内容从哪来。两点工程保证：
 *
 * 1. 行边界安全：不在半行处截断（始终在 '\n' 边界切）。
 * 2. UTF-8 安全：不返回半字符（多字节字符被截断时整段丢弃并打 `lastLinePartial` 标记）。
 *
 * - `truncateHead` 用于"文件读取"类场景：保留开头、丢弃尾部。
 * - `truncateTail` 用于"bash 输出"类场景：保留尾部、丢弃头部。
 *   bash 输出的错误信息基本都在末尾，tail 模式对调试更友好。
 */
import type { TruncationOptions, TruncationResult } from './types'

/** 默认最大行数（2000）。 */
export const DEFAULT_MAX_LINES = 2000
/** 默认最大字节数（50KB）。 */
export const DEFAULT_MAX_BYTES = 50 * 1024

/**
 * 从头部截断：保留前 N 行 / 前 N 字节。
 *
 * 当总行数 ≤ maxLines 且总字节数 ≤ maxBytes 时直接返回原文。
 * 否则按"先按行截、再按字节截"的顺序处理。
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  return truncateWithMode(content, options, 'head')
}

/** 从尾部截断：保留最后 N 行 / 最后 N 字节（bash 输出场景）。 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  return truncateWithMode(content, options, 'tail')
}

function truncateWithMode(
  content: string,
  options: TruncationOptions,
  defaultMode: 'head' | 'tail'
): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const mode = options.mode ?? defaultMode

  const totalBytes = Buffer.byteLength(content, 'utf8')
  const lines = splitLinesPreservingEmpty(content)
  const totalLines = lines.length

  // 没有触发截断
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false
    }
  }

  const selectedLines = mode === 'head' ? lines.slice(0, maxLines) : tailLines(lines, maxLines)

  // 行数先到限 → 截断维度 = 'lines'
  if (totalLines > maxLines && totalBytes > maxBytes && Buffer.byteLength(selectedLines.join('\n'), 'utf8') <= maxBytes) {
    return finalize(selectedLines.join('\n'), 'lines', totalLines, totalBytes, false)
  }
  if (totalLines > maxLines && totalBytes <= maxBytes) {
    return finalize(selectedLines.join('\n'), 'lines', totalLines, totalBytes, false)
  }

  // 进入字节维度裁剪
  const limited = truncateToBytes(selectedLines, maxBytes, mode === 'tail')
  if (limited.truncatedBy === 'bytes') {
    return {
      content: limited.content,
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: limited.outputLines,
      outputBytes: limited.outputBytes,
      lastLinePartial: limited.lastLinePartial
    }
  }

  return finalize(limited.content, limited.truncatedBy, totalLines, totalBytes, limited.lastLinePartial)
}

function finalize(
  content: string,
  truncatedBy: 'lines' | 'bytes' | null,
  totalLines: number,
  totalBytes: number,
  lastLinePartial: boolean
): TruncationResult {
  const outputLines = content.length === 0 ? 0 : content.split('\n').length
  const outputBytes = Buffer.byteLength(content, 'utf8')
  return {
    content,
    truncated: truncatedBy !== null,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines,
    outputBytes,
    lastLinePartial
  }
}

/** 切分但保留末尾空行（与 'foo\nbar\n'.split('\n') 行为不同）。 */
function splitLinesPreservingEmpty(content: string): string[] {
  if (content === '') return []
  // split 时保留最后可能存在的空字符串（表示原内容以 \n 结尾）
  const parts = content.split('\n')
  return parts
}

/** 保留最后 N 行（含空行）。 */
function tailLines(lines: string[], n: number): string[] {
  if (n <= 0) return []
  return lines.slice(Math.max(0, lines.length - n))
}

/**
 * 在已选中的行集合里按 maxBytes 裁剪。
 *
 * - head 模式：从前向后累加，直到下一行会越界为止。
 * - tail 模式：从后向前累加，超出时丢弃前几行。
 * - 单行本身就超过 maxBytes 时：
 *     - head 模式：取前 maxBytes 字符
 *     - tail 模式：取后 maxBytes 字符（保留最有用的尾部）
 *   都标记 lastLinePartial。
 */
function truncateToBytes(
  lines: string[],
  maxBytes: number,
  fromTail: boolean
): {
  content: string
  truncatedBy: 'bytes' | null
  outputLines: number
  outputBytes: number
  lastLinePartial: boolean
} {
  if (lines.length === 0) {
    return { content: '', truncatedBy: null, outputLines: 0, outputBytes: 0, lastLinePartial: false }
  }

  // 单行超限的特殊场景
  if (lines.length === 1) {
    const firstLineBytes = Buffer.byteLength(lines[0], 'utf8')
    if (firstLineBytes > maxBytes) {
      const cut = fromTail
        ? cutLineFromTail(lines[0], maxBytes)
        : cutLineToBytes(lines[0], maxBytes)
      return {
        content: cut,
        truncatedBy: 'bytes',
        outputLines: 1,
        outputBytes: Buffer.byteLength(cut, 'utf8'),
        lastLinePartial: true
      }
    }
  }

  if (!fromTail) {
    return accumulateFromHead(lines, maxBytes)
  }
  return accumulateFromTail(lines, maxBytes)
}

function accumulateFromHead(lines: string[], maxBytes: number) {
  const out: string[] = []
  let size = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineBytes = Buffer.byteLength(line, 'utf8')
    const sepBytes = i > 0 ? 1 : 0
    if (size + sepBytes + lineBytes > maxBytes) {
      // 当前行放不下：如果还没装任何内容，说明单行超限
      // head 模式：取该行的前 maxBytes 字符（保留头部语义）
      if (out.length === 0) {
        const cut = cutLineToBytes(line, maxBytes)
        return {
          content: cut,
          truncatedBy: 'bytes' as const,
          outputLines: 1,
          outputBytes: Buffer.byteLength(cut, 'utf8'),
          lastLinePartial: true
        }
      }
      return {
        content: out.join('\n'),
        truncatedBy: 'bytes' as const,
        outputLines: out.length,
        outputBytes: size,
        lastLinePartial: false
      }
    }
    if (i > 0) size += 1
    out.push(line)
    size += lineBytes
  }
  return { content: out.join('\n'), truncatedBy: null, outputLines: out.length, outputBytes: size, lastLinePartial: false }
}

function accumulateFromTail(lines: string[], maxBytes: number) {
  const out: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const lineBytes = Buffer.byteLength(line, 'utf8')
    const sepBytes = out.length > 0 ? 1 : 0
    if (size + sepBytes + lineBytes > maxBytes) {
      // 当前行放不下：如果还没装任何内容，说明单行（也就是原始顺序的末行）超限
      // tail 模式：取该行的后 maxBytes 字符（保留尾部语义，错误信息常在末尾）
      if (out.length === 0) {
        const cut = cutLineFromTail(line, maxBytes)
        return {
          content: cut,
          truncatedBy: 'bytes' as const,
          outputLines: 1,
          outputBytes: Buffer.byteLength(cut, 'utf8'),
          lastLinePartial: true
        }
      }
      return {
        content: out.join('\n'),
        truncatedBy: 'bytes' as const,
        outputLines: out.length,
        outputBytes: size,
        lastLinePartial: false
      }
    }
    if (out.length > 0) size += 1
    out.unshift(line)
    size += lineBytes
  }
  return { content: out.join('\n'), truncatedBy: null, outputLines: out.length, outputBytes: size, lastLinePartial: false }
}

/**
 * 把单行切到 maxBytes 以内。
 *
 * Buffer.slice 在字节维度截断不会拆掉多字节字符，但我们要保证：
 * - 不会返回半字符（用 toString('utf8') + 校验后缀连续字节）
 * - 至少留下 1 个有效字符
 *
 * 这里采用保守策略：按字符累加，直到累计字节数 ≤ maxBytes。
 * 字符级切分意味着绝对不会出现半个 UTF-8 字符。
 */
function cutLineToBytes(line: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let acc = ''
  let size = 0
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    if (size + chBytes > maxBytes) break
    acc += ch
    size += chBytes
    if (size === maxBytes) break
  }
  return acc
}

/**
 * 从行尾方向取 maxBytes 个字符。
 *
 * 字符级累加避免拆掉多字节字符。
 */
function cutLineFromTail(line: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let acc = ''
  let size = 0
  // 字符数组反向遍历
  const chars = Array.from(line)
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i]
    const chBytes = Buffer.byteLength(ch, 'utf8')
    if (size + chBytes > maxBytes) break
    acc = ch + acc
    size += chBytes
    if (size === maxBytes) break
  }
  return acc
}
