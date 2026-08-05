import React, { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_VIRTUAL_FILE_METRICS,
  type FileDiffOptions,
  type VirtualFileMetrics,
  type Virtualizer
} from '@pierre/diffs'
import { PatchDiff, VirtualizerContext } from '@pierre/diffs/react'
import { Button } from '@astryxdesign/core/Button'
import type { DiffEntry, DiffHunk } from '../../../shared/diff/types'
import { buildHunkPatch } from './pierrePatch'
import { acquirePierreVirtualizer } from './pierreVirtualizer'
import './diffLines.css'

export const PREVIEW_HUNK_LINE_LIMIT = 500
export const LARGE_PATCH_CHAR_THRESHOLD = 500_000
export const MAX_TOKENIZED_LINE_LENGTH = 1000

const DIFF_METRICS: VirtualFileMetrics = {
  ...DEFAULT_VIRTUAL_FILE_METRICS,
  lineHeight: 22,
  hunkSeparatorHeight: 24,
  spacing: 0
}

const PIERRE_CSS = `
:host {
  --diffs-font-family: var(--font-mono);
  --diffs-font-size: 0.8rem;
  --diffs-line-height: 22px;
}
`

export interface DiffRenderPolicy {
  disableWorkerPool: boolean
  lineDiffType: 'none' | 'word-alt'
  maxLineDiffLength: number
  tokenizeMaxLineLength: number
}

export function selectDiffRenderPolicy(
  patchLength: number,
  syntaxHighlight: boolean
): DiffRenderPolicy {
  const plainText = !syntaxHighlight || patchLength > LARGE_PATCH_CHAR_THRESHOLD

  return {
    disableWorkerPool: plainText,
    lineDiffType: plainText ? 'none' : 'word-alt',
    maxLineDiffLength: plainText ? 0 : MAX_TOKENIZED_LINE_LENGTH,
    tokenizeMaxLineLength: plainText ? 0 : MAX_TOKENIZED_LINE_LENGTH
  }
}

export interface HunkViewProps {
  hunk: DiffHunk
  filePath: string
  status: DiffEntry['status']
  syntaxHighlight?: boolean
  wrap?: boolean
  scrollRef?: React.RefObject<HTMLDivElement | null>
}

export const HunkView: React.FC<HunkViewProps> = ({
  hunk,
  filePath,
  status,
  syntaxHighlight = true,
  wrap = false,
  scrollRef
}) => {
  const [showFull, setShowFull] = useState(false)
  const [virtualizer, setVirtualizer] = useState<Virtualizer>()

  useEffect(() => {
    const scrollElement = scrollRef?.current
    if (!scrollElement) return

    const lease = acquirePierreVirtualizer(scrollElement)
    setVirtualizer(lease.virtualizer)
    return lease.release
  }, [scrollRef])

  const preview = useMemo(
    () => buildHunkPatch(
      filePath,
      hunk,
      status,
      showFull ? undefined : PREVIEW_HUNK_LINE_LIMIT
    ),
    [filePath, hunk, status, showFull]
  )
  const policy = useMemo(
    () => selectDiffRenderPolicy(preview.patch.length, syntaxHighlight),
    [preview.patch.length, syntaxHighlight]
  )
  const options = useMemo<FileDiffOptions<undefined>>(() => ({
    diffStyle: 'unified',
    overflow: wrap ? 'wrap' : 'scroll',
    disableFileHeader: true,
    hunkSeparators: 'line-info-basic',
    lineDiffType: policy.lineDiffType,
    maxLineDiffLength: policy.maxLineDiffLength,
    tokenizeMaxLineLength: policy.tokenizeMaxLineLength,
    unsafeCSS: PIERRE_CSS
  }), [policy, wrap])

  const diff = (
    <PatchDiff
      patch={preview.patch}
      options={options}
      metrics={DIFF_METRICS}
      disableWorkerPool={policy.disableWorkerPool}
      className="nova-pierre-diff"
    />
  )

  return (
    <div className="diff-hunk diff-hunk--pierre">
      {scrollRef && !virtualizer ? (
        <div className="diff-hunk__pending">正在准备差异视图…</div>
      ) : virtualizer ? (
        <VirtualizerContext.Provider value={virtualizer}>
          {diff}
        </VirtualizerContext.Provider>
      ) : diff}
      {preview.omittedLines > 0 && (
        <Button
          label={`还有 ${preview.omittedLines} 行未显示，点击展开完整 hunk`}
          variant="ghost"
          size="sm"
          className="diff-hunk__truncation"
          onClick={() => setShowFull(true)}
        />
      )}
      {showFull && preview.totalLines > PREVIEW_HUNK_LINE_LIMIT && (
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
