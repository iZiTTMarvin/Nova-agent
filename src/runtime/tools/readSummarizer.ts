/**
 * readSummarizer — 源码文件结构化摘要（启发式 / 正则，无 AST）
 *
 * 对支持的语言大文件生成紧凑摘要：保留 imports、类/函数签名，
 * 折叠函数体为 `{folded}: N lines`，文件尾保留最后 20 行（exports 区）。
 */
import { extname } from 'path'

/** 支持结构化摘要的扩展名 */
export const SUMMARIZABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'
])

/** 触发摘要的最小行数（与 readTool 配合） */
export const MIN_SUMMARY_LINES = 400

/** 文件尾保留行数（exports 区） */
const TAIL_LINE_COUNT = 20

type LangFamily = 'brace' | 'python'

/** 根据扩展名判断语言族（花括号 vs Python 缩进） */
function getLangFamily(ext: string): LangFamily | null {
  if (['.ts', '.tsx', '.js', '.jsx', '.go', '.rs'].includes(ext)) return 'brace'
  if (ext === '.py') return 'python'
  return null
}

/** 统计有效行数（排除 split 尾部空串） */
function countLines(lines: string[]): number {
  return lines.length > 0 && lines[lines.length - 1] === ''
    ? lines.length - 1
    : lines.length
}

/** 是否为 import / 文件头区域行 */
function isImportOrHeaderLine(line: string, ext: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return true

  if (ext === '.py') {
    return /^(import\b|from\s+\S+\s+import\b|#)/.test(trimmed)
  }
  if (ext === '.go') {
    return /^(package\b|import\b|\/\/)/.test(trimmed)
  }
  if (ext === '.rs') {
    return /^(use\b|extern crate\b|mod\s+\w+\s*;|\/\/|\/\*)/.test(trimmed)
  }
  // TS / JS
  return /^(import\b|export\s+[\w*{]+\s+from\b|\/\/|\/\*|\*|"use strict"|'use strict')/.test(trimmed)
}

/** 提取文件顶部 imports / header 区 */
function extractImportSection(lines: string[], ext: string): string[] {
  const result: string[] = []
  let seenImport = false

  for (const line of lines) {
    if (isImportOrHeaderLine(line, ext)) {
      result.push(line)
      if (line.trim() !== '' && !line.trim().startsWith('//') && !line.trim().startsWith('#')) {
        seenImport = true
      }
    } else if (!seenImport && line.trim() === '') {
      result.push(line)
    } else {
      break
    }
  }
  return result
}

/** 是否为应保留的类 / 函数 / 类型签名行 */
function isSignatureLine(line: string, ext: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) return false

  if (ext === '.py') {
    return /^(async\s+)?def\s+\w+/.test(trimmed) || /^class\s+\w+/.test(trimmed)
  }
  if (ext === '.go') {
    return /^func\s+(\(\s*\w+\s+\*?\w+\s*\)\s+)?\w+/.test(trimmed) ||
      /^type\s+\w+\s+(struct|interface)\b/.test(trimmed)
  }
  if (ext === '.rs') {
    return /^(pub\s+)?(async\s+)?fn\s+\w+/.test(trimmed) ||
      /^(pub\s+)?(struct|enum|impl|trait)\b/.test(trimmed)
  }
  // TS / JS
  return (
    /^(export\s+)?(async\s+)?function\s+\w+/.test(trimmed) ||
    /^(export\s+)?class\s+\w+/.test(trimmed) ||
    /^(export\s+)?interface\s+\w+/.test(trimmed) ||
    /^(export\s+)?type\s+\w+/.test(trimmed) ||
    /^(export\s+)?enum\s+\w+/.test(trimmed) ||
    /^(export\s+)?(async\s+)?function\s*\*/.test(trimmed) ||
    /^(export\s+)?const\s+\w+\s*=\s*(async\s+)?(\([^)]*\)|[\w.]+)\s*=>/.test(trimmed) ||
    /^(export\s+)?(public|private|protected|static|readonly|async|\s)*[\w<>\[\]]+\s+\w+\s*\(/.test(trimmed)
  )
}

/** 花括号语言：统计一行中的 { 和 } 增量 */
function braceDelta(line: string): number {
  let delta = 0
  let inString: '"' | "'" | '`' | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inString) {
      if (ch === '\\') { i++; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue }
    if (ch === '{') delta++
    if (ch === '}') delta--
  }
  return delta
}

/** 行上是否含 opening brace（用于判断是否有可折叠函数体） */
function hasOpeningBrace(line: string): boolean {
  return braceDelta(line) > 0 || line.includes('{')
}

/** 折叠花括号块：保留起始行，跳过内部，输出 folded 标记 */
function foldBraceBlock(
  lines: string[],
  startIdx: number
): { output: string[]; nextIdx: number } {
  const output = [lines[startIdx]]
  let depth = braceDelta(lines[startIdx])
  let i = startIdx + 1

  // 签名可能跨行，先找到 `{`
  while (depth <= 0 && i < lines.length) {
    output.push(lines[i])
    depth += braceDelta(lines[i])
    i++
  }

  const bodyStart = i
  while (i < lines.length && depth > 0) {
    depth += braceDelta(lines[i])
    i++
  }

  const bodyLines = i - bodyStart
  if (bodyLines > 0) {
    output.push(`{folded}: ${bodyLines} lines`)
  }
  return { output, nextIdx: i }
}

/** 折叠 Python 缩进块 */
function foldPythonBlock(
  lines: string[],
  startIdx: number
): { output: string[]; nextIdx: number } {
  const output = [lines[startIdx]]
  const baseIndent = lines[startIdx].match(/^(\s*)/)?.[1].length ?? 0
  let i = startIdx + 1

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { i++; continue }
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0
    if (indent <= baseIndent) break
    i++
  }

  const bodyLines = i - startIdx - 1
  if (bodyLines > 0) {
    output.push(`{folded}: ${bodyLines} lines`)
  }
  return { output, nextIdx: i }
}

/** 折叠中间区域（imports 之后、tail 之前） */
function summarizeMiddle(lines: string[], ext: string): string[] {
  const family = getLangFamily(ext)
  if (!family) return lines

  const output: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (isSignatureLine(line, ext)) {
      if (family === 'python' && line.trimEnd().endsWith(':')) {
        const folded = foldPythonBlock(lines, i)
        output.push(...folded.output)
        i = folded.nextIdx
        continue
      }
      if (family === 'brace' && (hasOpeningBrace(line) || (i + 1 < lines.length && lines[i + 1].trim().startsWith('{')))) {
        const folded = foldBraceBlock(lines, i)
        output.push(...folded.output)
        i = folded.nextIdx
        continue
      }
      // 无函数体的签名（interface / type / 单行声明）原样保留
      output.push(line)
      i++
      continue
    }

    // 跳过已折叠块内部的杂散行
    i++
  }

  return output
}

/**
 * 生成结构化摘要。
 * 不支持扩展名或行数 < MIN_SUMMARY_LINES 时返回 null。
 */
export function summarizeStructure(filePath: string, content: string): string | null {
  const ext = extname(filePath).toLowerCase()
  if (!SUMMARIZABLE_EXTENSIONS.has(ext)) return null
  if (!getLangFamily(ext)) return null

  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (countLines(lines) < MIN_SUMMARY_LINES) return null

  const importSection = extractImportSection(lines, ext)
  const tailStart = Math.max(importSection.length, lines.length - TAIL_LINE_COUNT)
  const middle = lines.slice(importSection.length, tailStart)
  const tail = lines.slice(tailStart)

  const summarizedMiddle = summarizeMiddle(middle, ext)

  const parts: string[] = [
    ...importSection,
    ...(importSection.length > 0 && summarizedMiddle.length > 0 ? [''] : []),
    ...summarizedMiddle,
    ...(tail.length > 0 ? ['', '--- exports (last 20 lines) ---', ...tail] : [])
  ]

  return parts.join('\n')
}

/** 判断扩展名是否支持结构化摘要 */
export function isSummarizableExtension(filePathOrExt: string): boolean {
  const ext = filePathOrExt.startsWith('.')
    ? filePathOrExt.toLowerCase()
    : extname(filePathOrExt).toLowerCase()
  return SUMMARIZABLE_EXTENSIONS.has(ext)
}
