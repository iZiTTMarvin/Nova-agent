/**
 * editDiff — 编辑工具的纯文本处理层
 * 包含：多编码检测与往返、LCS 行级 diff、unified patch 生成、变更区域 snippet 提取
 */
import type { ResolvedEdit } from './editTool'
import iconv from 'iconv-lite'

// ── fileEncoding ──────────────────────────────────────────────────────────────

export type FileEncoding = 'utf-8' | 'utf-8-bom' | 'gbk' | 'utf-16le' | 'utf-16be' | 'latin-1'

const UTF8_BOM = '\uFEFF'
const UTF16LE_BOM_BYTES = [0xFF, 0xFE]
const UTF16BE_BOM_BYTES = [0xFE, 0xFF]
const UTF8_BOM_BYTES = [0xEF, 0xBB, 0xBF]

function startsWithBytes(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false
  for (let i = 0; i < bytes.length; i++) {
    if (buf[i] !== bytes[i]) return false
  }
  return true
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    decoder.decode(buf)
    return true
  } catch {
    return false
  }
}

function isLikelyGbk(buf: Buffer): boolean {
  let i = 0
  let hasDoubleByte = false
  while (i < buf.length) {
    const b = buf[i]
    if (b <= 0x7F) {
      i++
      continue
    }
    if (b >= 0x81 && b <= 0xFE && i + 1 < buf.length) {
      const b2 = buf[i + 1]
      if ((b2 >= 0x40 && b2 <= 0x7E) || (b2 >= 0x80 && b2 <= 0xFE)) {
        hasDoubleByte = true
        i += 2
        continue
      }
    }
    return false
  }
  return hasDoubleByte
}

function decodeGbk(buf: Buffer): string {
  try {
    return iconv.decode(buf, 'gbk')
  } catch {
    return buf.toString('latin1')
  }
}

export function decodeFileBuffer(buf: Buffer): { text: string; encoding: FileEncoding } {
  if (startsWithBytes(buf, UTF16LE_BOM_BYTES)) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' }
  }

  if (startsWithBytes(buf, UTF16BE_BOM_BYTES)) {
    const swapped = Buffer.alloc(buf.length - 2)
    for (let i = 2; i < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1]
      swapped[i - 1] = buf[i]
    }
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be' }
  }

  if (startsWithBytes(buf, UTF8_BOM_BYTES)) {
    const text = buf.subarray(3).toString('utf-8')
    return { text: UTF8_BOM + text, encoding: 'utf-8-bom' }
  }

  if (isValidUtf8(buf)) {
    return { text: buf.toString('utf-8'), encoding: 'utf-8' }
  }

  if (isLikelyGbk(buf)) {
    return { text: decodeGbk(buf), encoding: 'gbk' }
  }

  return { text: buf.toString('latin1'), encoding: 'latin-1' }
}

export function encodeFile(text: string, encoding: FileEncoding): Buffer {
  switch (encoding) {
    case 'utf-8-bom':
      return Buffer.from(UTF8_BOM + text, 'utf-8')
    case 'utf-16le': {
      const bom = Buffer.from([0xFF, 0xFE])
      const content = Buffer.from(text, 'utf16le')
      return Buffer.concat([bom, content])
    }
    case 'utf-16be': {
      const bom = Buffer.from([0xFE, 0xFF])
      const le = Buffer.from(text, 'utf16le')
      const swapped = Buffer.alloc(le.length)
      for (let i = 0; i < le.length; i += 2) {
        swapped[i] = le[i + 1]
        swapped[i + 1] = le[i]
      }
      return Buffer.concat([bom, swapped])
    }
    case 'gbk':
      return iconv.encode(text, 'gbk')
    case 'latin-1':
      return Buffer.from(text, 'latin1')
    case 'utf-8':
    default:
      return Buffer.from(text, 'utf-8')
  }
}

// ── lineDiff ──────────────────────────────────────────────────────────────────

type DiffOp = '-' | '+' | ' '

interface DiffLine {
  op: DiffOp
  line: string
}

function lcsDiff(a: readonly string[], b: readonly string[]): DiffLine[] {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  const result: DiffLine[] = []
  let i = m
  let j = n

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ op: ' ', line: a[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ op: '+', line: b[j - 1] })
      j--
    } else {
      result.push({ op: '-', line: a[i - 1] })
      i--
    }
  }

  result.reverse()
  return result
}

export function lineDiff(
  original: string,
  newContent: string,
): DiffLine[] {
  return lcsDiff(original.split('\n'), newContent.split('\n'))
}

export function renderLineDiff(diff: DiffLine[]): string {
  return diff.map(d => d.op + d.line).join('\n')
}

export function computeFirstChangedLine(original: string, newContent: string): number {
  const oldLines = original.split('\n')
  const newLines = newContent.split('\n')
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    if (oldLines[i] !== newLines[i]) return i + 1
  }
  return 1
}

// ── unified patch ─────────────────────────────────────────────────────────────

const CONTEXT_LINES = 3

export function generateUnifiedPatch(
  path: string,
  original: string,
  newContent: string,
): string {
  const diff = lcsDiff(original.split('\n'), newContent.split('\n'))
  if (diff.every(d => d.op === ' ')) return ''

  const hunks = buildHunks(diff)
  const header = `--- a/${path}\n+++ b/${path}`
  const hunkStrings = hunks.map(h => {
    const range = `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`
    return range + '\n' + h.lines.join('\n')
  })

  return header + '\n' + hunkStrings.join('\n')
}

interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}

function buildHunks(diff: DiffLine[]): Hunk[] {
  const changeIndices: number[] = []
  for (let i = 0; i < diff.length; i++) {
    if (diff[i].op !== ' ') changeIndices.push(i)
  }
  if (changeIndices.length === 0) return []

  const ranges: Array<[number, number]> = []
  for (const idx of changeIndices) {
    const lo = Math.max(0, idx - CONTEXT_LINES)
    const hi = Math.min(diff.length - 1, idx + CONTEXT_LINES)
    if (ranges.length > 0 && lo <= ranges[ranges.length - 1][1] + 1) {
      ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], hi)
    } else {
      ranges.push([lo, hi])
    }
  }

  return ranges.map(([start, end]) => {
    let oldLine = 1
    let newLine = 1
    for (let k = 0; k < start; k++) {
      if (diff[k].op === ' ') { oldLine++; newLine++ }
      else if (diff[k].op === '-') { oldLine++ }
      else { newLine++ }
    }

    const oldStart = oldLine
    const newStart = newLine
    let oldCount = 0
    let newCount = 0
    const lines: string[] = []

    for (let k = start; k <= end; k++) {
      const d = diff[k]
      if (d.op === ' ') {
        lines.push(' ' + d.line)
        oldCount++
        newCount++
      } else if (d.op === '-') {
        lines.push('-' + d.line)
        oldCount++
      } else {
        lines.push('+' + d.line)
        newCount++
      }
    }

    return { oldStart, oldCount, newStart, newCount, lines }
  })
}

// ── snippet ───────────────────────────────────────────────────────────────────

export function extractSnippet(
  newContent: string,
  resolved: ResolvedEdit[],
  contextLines: number = 4,
): string {
  const lines = newContent.split('\n')
  const snippets: string[] = []

  for (const edit of resolved) {
    const targetLine = newContent.substring(0, newContent.indexOf(edit.actualNewText)).split('\n').length - 1
    const start = Math.max(0, targetLine - contextLines)
    const end = Math.min(lines.length - 1, targetLine + contextLines)
    const snippetLines = lines.slice(start, end + 1).map((l, i) => {
      const lineNum = start + i + 1
      return `${String(lineNum).padStart(4)} | ${l}`
    })
    snippets.push(snippetLines.join('\n'))
  }

  return snippets.join('\n...\n')
}
