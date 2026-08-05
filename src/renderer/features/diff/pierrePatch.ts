import type { DiffHunk } from '../../../shared/diff/types'

export interface HunkPatchPreview {
  patch: string
  totalLines: number
  renderedLines: number
  omittedLines: number
}

function splitHunkContent(content: string): string[] {
  return content === '' ? [] : content.split('\n')
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '')
}

function formatGitPath(filePath: string): string {
  return /[\s"\\]/.test(filePath) ? JSON.stringify(filePath) : filePath
}

function inferStatus(hunk: DiffHunk): 'added' | 'modified' | 'deleted' {
  if (hunk.oldStart === 0 && hunk.oldLines === 0) return 'added'
  if (hunk.newStart === 0 && hunk.newLines === 0) return 'deleted'
  return 'modified'
}

function countSpan(lines: string[]): { oldLines: number; newLines: number } {
  let oldLines = 0
  let newLines = 0

  for (const line of lines) {
    if (!line.startsWith('+')) oldLines++
    if (!line.startsWith('-')) newLines++
  }

  return { oldLines, newLines }
}

export function buildHunkPatch(
  filePath: string,
  hunk: DiffHunk,
  lineLimit?: number
): HunkPatchPreview {
  const normalizedPath = normalizePath(filePath)
  const status = inferStatus(hunk)
  const allLines = splitHunkContent(hunk.content)
  const rendered = lineLimit === undefined ? allLines : allLines.slice(0, lineLimit)
  const { oldLines, newLines } = countSpan(rendered)

  const oldPath = status === 'added' ? '/dev/null' : `a/${normalizedPath}`
  const newPath = status === 'deleted' ? '/dev/null' : `b/${normalizedPath}`
  const patchLines = [
    `diff --git ${formatGitPath(`a/${normalizedPath}`)} ${formatGitPath(`b/${normalizedPath}`)}`,
    `--- ${formatGitPath(oldPath)}`,
    `+++ ${formatGitPath(newPath)}`
  ]

  if (rendered.length > 0) {
    patchLines.push(
      `@@ -${hunk.oldStart},${oldLines} +${hunk.newStart},${newLines} @@`,
      ...rendered
    )
  }

  return {
    patch: patchLines.join('\n'),
    totalLines: allLines.length,
    renderedLines: rendered.length,
    omittedLines: allLines.length - rendered.length
  }
}
