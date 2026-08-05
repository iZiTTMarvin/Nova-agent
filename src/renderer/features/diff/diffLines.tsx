/**
 * 共享 diff 行 / hunk 渲染（DiffViewer 与 Inspector ReviewTab 共用）。
 * 大 hunk 走虚拟化（只渲染可见窗口），避免几千行 diff 全量挂载阻塞主线程。
 */
import React, { useMemo, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@astryxdesign/core/Button'
import type { DiffEntry, DiffHunk } from '../../../shared/diff/types'
import { highlightLine } from './syntaxHighlight'
import { highlightLineCached } from '../../lib/highlightCache'
import './diffLines.css'

/** 单个 hunk 超过此行数时截断展示 */
export const PREVIEW_HUNK_LINE_LIMIT = 500

/** 超过此行数的大 hunk 启用虚拟化（只渲染可见窗口） */
export const VIRTUALIZE_HUNK_LINE_THRESHOLD = 80

/** diff 行固定高度（px），虚拟化 estimateSize 用；与 .diff-line 的 min-height 对齐 */
export const DIFF_LINE_HEIGHT_PX = 22

/** 虚拟化 overscan（上下各多渲染的行数） */
const VIRTUAL_OVERSCAN = 10

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
  /** 外层滚动容器；大 hunk 虚拟化时使用（保证多 hunk 共用同一滚动条） */
  scrollRef?: React.RefObject<HTMLDivElement | null>
}

/** 单行渲染（虚拟化行共用，纯展示） */
const DiffLineViewInner: React.FC<{
  line: ComputedDiffLine
  filePath: string
  syntaxHighlight: boolean
  wrap: boolean
}> = ({ line, filePath, syntaxHighlight, wrap }) => (
  <DiffLineView
    prefix={line.prefix}
    text={line.text}
    realLineNo={line.realLineNo}
    filePath={filePath}
    syntaxHighlight={syntaxHighlight}
    wrap={wrap}
  />
)

/**
 * 大 hunk 虚拟化渲染：只挂载可见窗口的行，滚动时动态补行。
 * 使用外层滚动容器（scrollRef），保证多个 hunk 共用同一滚动条。
 * 固定行高（DIFF_LINE_HEIGHT_PX）保证 estimateSize 精确、滚动无跳动。
 */
const VirtualHunk: React.FC<{
  lines: ComputedDiffLine[]
  filePath: string
  syntaxHighlight: boolean
  wrap: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
}> = ({ lines, filePath, syntaxHighlight, wrap, scrollRef }) => {
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => DIFF_LINE_HEIGHT_PX,
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: (index) => index
  })
  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  // 视口尚未量出尺寸（jsdom / 首帧 / 容器未布局）时，渲染一个尾部窗口，
  // 避免 0 行空白。真实视口量出后由 virtualizer 接管。
  const scrolled = virtualItems.length > 0
  const fallbackCount = Math.min(lines.length, VIRTUAL_OVERSCAN * 2 + 10)
  const fallbackStart = Math.max(0, lines.length - fallbackCount)
  const rendered = scrolled
    ? virtualItems
    : Array.from({ length: fallbackCount }, (_, i) => fallbackStart + i)

  return (
    <div className="diff-hunk__virtual" style={{ position: 'relative', height: totalSize }}>
      {rendered.map((vi) => {
        const index = typeof vi === 'number' ? vi : vi.index
        const start = typeof vi === 'number' ? index * DIFF_LINE_HEIGHT_PX : vi.start
        const size = typeof vi === 'number' ? DIFF_LINE_HEIGHT_PX : vi.size
        const line = lines[index]
        return (
          <div
            key={index}
            data-virtual-index={index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${start}px)`,
              height: size
            }}
          >
            <DiffLineViewInner
              line={line}
              filePath={filePath}
              syntaxHighlight={syntaxHighlight}
              wrap={wrap}
            />
          </div>
        )
      })}
    </div>
  )
}

/** Hunk 渲染。小 hunk 全量渲染；大 hunk 虚拟化（只渲染可见窗口） */
export const HunkView: React.FC<HunkViewProps> = ({
  hunk,
  filePath,
  syntaxHighlight = true,
  wrap = false,
  scrollRef
}) => {
  const allLines = useMemo(() => computeDiffLines(hunk), [hunk])
  // wrap 折行时行高不固定，虚拟化会错位 → 禁用；仅大 hunk + 非折行走虚拟化
  const useVirtual = allLines.length > VIRTUALIZE_HUNK_LINE_THRESHOLD && !wrap && !!scrollRef

  // 虚拟化路径本身是性能护栏（DOM 常数级），无需截断，直接完整渲染；
  // 仅非虚拟化（小 hunk / 折行）保留截断保护。
  const [showFull, setShowFull] = useState(false)
  const needsTruncation = !useVirtual && allLines.length > PREVIEW_HUNK_LINE_LIMIT
  const displayLines = useVirtual || showFull
    ? allLines
    : allLines.slice(0, PREVIEW_HUNK_LINE_LIMIT)

  return (
    <div className="diff-hunk">
      <div className="diff-hunk__header">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      {useVirtual ? (
        <VirtualHunk
          lines={displayLines}
          filePath={filePath}
          syntaxHighlight={syntaxHighlight}
          wrap={wrap}
          scrollRef={scrollRef}
        />
      ) : (
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
        </div>
      )}
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
