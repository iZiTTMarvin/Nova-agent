/**
 * 行级 diff 计算模块
 *
 * 基于 LCS（最长公共子序列）算法比较两段文本，
 * 生成 DiffEntry 列表，供前端 DiffViewer 渲染。
 */
import type { DiffEntry, DiffHunk } from './types'

/** 行变更标记 */
type Op = 'equal' | 'add' | 'remove'

/** 内部差异行 */
interface DiffLine {
  op: Op
  text: string
}

/** hunk 输出中上下文行数 */
const CONTEXT = 3

/**
 * LCS 长度矩阵，用于对齐旧行和新行
 */
function lcs(a: string[], b: string[]): number[][] {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp
}

/**
 * 从 LCS 矩阵回溯生成差异行序列
 */
function diffLines(oldText: string[], newText: string[]): DiffLine[] {
  const dp = lcs(oldText, newText)
  const result: DiffLine[] = []
  let i = oldText.length
  let j = newText.length

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldText[i - 1] === newText[j - 1]) {
      result.push({ op: 'equal', text: oldText[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ op: 'add', text: newText[j - 1] })
      j--
    } else {
      result.push({ op: 'remove', text: oldText[i - 1] })
      i--
    }
  }

  result.reverse()
  return result
}

/**
 * 将差异行序列按 unified diff 格式分割成 hunk
 */
function toHunks(lines: DiffLine[]): DiffHunk[] {
  if (lines.length === 0) return []

  // 找出所有包含变更的区域
  const changeIdx: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].op !== 'equal') changeIdx.push(i)
  }
  if (changeIdx.length === 0) return []

  // 合并相近的变更区域（上下文行数内的合并为一个 hunk）
  const ranges: Array<[number, number]> = []
  for (const idx of changeIdx) {
    const lo = Math.max(0, idx - CONTEXT)
    const hi = Math.min(lines.length - 1, idx + CONTEXT)
    if (ranges.length > 0 && lo <= ranges[ranges.length - 1][1] + 1) {
      ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], hi)
    } else {
      ranges.push([lo, hi])
    }
  }

  return ranges.map(([start, end]) => {
    const slice = lines.slice(start, end + 1)

    // 计算旧行和新行的起始行号
    let oldLine = 0
    let newLine = 0
    let oldCount = 0
    let newCount = 0

    // 先从头推算出行号
    let o = 1
    let n = 1
    for (let k = 0; k < start; k++) {
      if (lines[k].op === 'equal') { o++; n++ }
      else if (lines[k].op === 'remove') { o++ }
      else { n++ }
    }

    oldLine = o
    newLine = n

    const contentParts: string[] = []
    for (const ln of slice) {
      if (ln.op === 'equal') {
        contentParts.push(' ' + ln.text)
        oldCount++
        newCount++
        o++
        n++
      } else if (ln.op === 'remove') {
        contentParts.push('-' + ln.text)
        oldCount++
        o++
      } else {
        contentParts.push('+' + ln.text)
        newCount++
        n++
      }
    }

    return {
      oldStart: oldLine,
      oldLines: oldCount,
      newStart: newLine,
      newLines: newCount,
      content: contentParts.join('\n')
    }
  })
}

/**
 * 比较两段文本，生成单个文件的 DiffEntry
 */
export function computeFileDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
  status: 'added' | 'modified' | 'deleted'
): DiffEntry {
  if (status === 'added') {
    const lines = newContent.split('\n')
    return {
      filePath,
      status: 'added',
      hunks: [{
        oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length,
        content: lines.map(l => '+' + l).join('\n')
      }]
    }
  }

  if (status === 'deleted') {
    const lines = oldContent.split('\n')
    return {
      filePath,
      status: 'deleted',
      hunks: [{
        oldStart: 1, oldLines: lines.length, newStart: 0, newLines: 0,
        content: lines.map(l => '-' + l).join('\n')
      }]
    }
  }

  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const dLines = diffLines(oldLines, newLines)
  return {
    filePath,
    status: 'modified',
    hunks: toHunks(dLines)
  }
}
