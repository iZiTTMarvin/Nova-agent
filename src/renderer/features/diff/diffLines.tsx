/**
 * 共享 diff 行 / hunk 渲染（DiffViewer 与 Inspector ReviewTab 共用）。
 */
import React, { useMemo, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import type { DiffEntry, DiffHunk } from '../../../shared/diff/types'
import { highlightLine } from './syntaxHighlight'
import { highlightLineCached } from '../../lib/highlightCache'
import './diffLines.css'

/** 单个 hunk 超过此行数时截断展示 */
export const PREVIEW_HUNK_LINE_LIMIT = 500

export interface DiffLineViewProps {
  prefix: string
  text: string
  realLineNo: number
  filePath: string
  /** 默认开启语法高亮；文本模式关闭 */
  syntaxHighlight?: boolean
  wrap?: boolean
}

/** 单行 diff 渲染 */
export const DiffLineView: React.FC<DiffLineViewProps> = ({
  prefix,
  text,
  realLineNo,
  filePath,
  syntaxHighlight = true,
  wrap = false
}) => {
  const type = prefix === '+' ? 'add' : prefix === '-' ? 'remove' : 'context'
  const tokens = syntaxHighlight ? highlightLineCached(text, filePath, highlightLine) : null

  return (
    <div className={`diff-line diff-line--${type}`}>
      <span className="diff-line__no">{realLineNo || ''}</span>
      <span className={`diff-line__text${wrap ? ' diff-line__text--wrap' : ''}`}>
        <span className="diff-line__prefix">{prefix}</span>
        {tokens
          ? tokens.map((token, idx) => (
              <span key={idx} className={`diff-token diff-token--${token.type}`}>{token.text}</span>
            ))
          : text}
      </span>
    </div>
  )
}

/** 预计算单行 diff 信息，避免渲染时依赖递增状态 */
export interface ComputedDiffLine {
  prefix: string
  text: string
  realLineNo: number
}

/** 从 hunk content 预计算所有行的 diff 信息 */
export function computeDiffLines(hunk: DiffHunk): ComputedDiffLine[] {
  const lines = hunk.content.split('\n')
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  return lines.map(line => {
    const prefix = line[0] || ' '
    const text = line.slice(1)
    let lineNo = 0
    if (prefix === ' ') {
      lineNo = oldLine; oldLine++; newLine++
    } else if (prefix === '+') {
      lineNo = newLine; newLine++
    } else {
      lineNo = oldLine; oldLine++
    }
    return { prefix, text, realLineNo: lineNo }
  })
}

export interface HunkViewProps {
  hunk: DiffHunk
  filePath: string
  syntaxHighlight?: boolean
  wrap?: boolean
}

/** Hunk 渲染。大 hunk 截断展示，保留行级直接渲染 */
export const HunkView: React.FC<HunkViewProps> = ({
  hunk,
  filePath,
  syntaxHighlight = true,
  wrap = false
}) => {
  const allLines = useMemo(() => computeDiffLines(hunk), [hunk])
  const needsTruncation = allLines.length > PREVIEW_HUNK_LINE_LIMIT
  const [showFull, setShowFull] = useState(false)
  const displayLines = showFull ? allLines : allLines.slice(0, PREVIEW_HUNK_LINE_LIMIT)

  return (
    <div className="diff-hunk">
      <div className="diff-hunk__header">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      <div className={`diff-hunk__content${wrap ? ' diff-hunk__content--wrap' : ''}`}>
        {displayLines.map((line, idx) => (
          <DiffLineView
            key={idx}
            prefix={line.prefix}
            text={line.text}
            realLineNo={line.realLineNo}
            filePath={filePath}
            syntaxHighlight={syntaxHighlight}
            wrap={wrap}
          />
        ))}
        {needsTruncation && !showFull && (
          <Button
            label={`还有 ${allLines.length - PREVIEW_HUNK_LINE_LIMIT} 行未显示，点击展开完整 hunk`}
            variant="ghost"
            size="sm"
            className="diff-hunk__truncation"
            onClick={() => setShowFull(true)}
          />
        )}
        {needsTruncation && showFull && (
          <Button
            label="点击折叠"
            variant="ghost"
            size="sm"
            className="diff-hunk__truncation"
            onClick={() => setShowFull(false)}
          >
            点击折叠
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * 按 hunk content 的 +/- 前缀统计真实增删行。
 * hunk.oldLines/newLines 是 hunk 头跨度（含上下文行），不能当增删计数。
 */
export function countEntryChanges(entry: DiffEntry): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of entry.hunks) {
    if (!hunk.content) continue
    for (const line of hunk.content.split('\n')) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) deletions++
    }
  }
  return { additions, deletions }
}
