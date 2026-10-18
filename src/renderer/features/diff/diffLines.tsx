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
import { useSettingsStore } from '../../stores/useSettingsStore'
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

/**
 * 构建注入 Pierre Shadow DOM 的主题与排版样式。
 * 显式指定 color-scheme 与表面背景/文字变量，避免纯文本文件（如 .gitignore）
 * 或未走 Shiki Worker 的大文件在深色模式下回退到刺眼的亮白底色。
 */
export function buildPierreCss(resolvedTheme: 'light' | 'dark'): string {
  const isDark = resolvedTheme === 'dark'
  const bg = isDark ? '#141417' : '#f8f8fa'
  const fg = isDark ? '#f4f4f5' : '#18181b'
  const contextBg = isDark ? '#18181c' : '#f1f1f4'
  const separatorBg = isDark ? '#1f1f24' : '#ececf0'

  return `
:host, [data-diffs], [data-diffs-header], [data-error-wrapper] {
  color-scheme: ${resolvedTheme};
  --diffs-font-family: var(--font-mono);
  --diffs-font-size: 0.8rem;
  --diffs-line-height: 22px;
  --diffs-light-bg: #f8f8fa;
  --diffs-dark-bg: #141417;
  --diffs-light: #18181b;
  --diffs-dark: #f4f4f5;
  --diffs-bg: ${bg};
  --diffs-fg: ${fg};
  --diffs-bg-context-override: ${contextBg};
  --diffs-bg-separator-override: ${separatorBg};
  --diffs-bg-buffer-override: ${contextBg};
}
`
}

function useResolvedDiffTheme(): 'light' | 'dark' {
  const theme = useSettingsStore(s => s.theme)
  const [systemDark, setSystemDark] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    if (theme !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemDark(mq.matches)
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  if (theme === 'dark') return 'dark'
  if (theme === 'light') return 'light'
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme')
    if (attr === 'dark' || attr === 'light') return attr
  }
  return systemDark ? 'dark' : 'light'
}

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
  const resolvedTheme = useResolvedDiffTheme()

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
    themeType: resolvedTheme,
    overflow: wrap ? 'wrap' : 'scroll',
    disableFileHeader: true,
    hunkSeparators: 'line-info-basic',
    lineDiffType: policy.lineDiffType,
    maxLineDiffLength: policy.maxLineDiffLength,
    tokenizeMaxLineLength: policy.tokenizeMaxLineLength,
    unsafeCSS: buildPierreCss(resolvedTheme)
  }), [policy, resolvedTheme, wrap])

  // VirtualizedFileDiff 内部对 this.fileDiff 使用 ??= 惰性赋值，
  // 用 patch 内容作为 key 确保切换文件或展开完整 hunk 时重建实例。
  const diff = (
    <PatchDiff
      key={preview.patch}
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

// 增删行统计的唯一实现在 shared/diff/compute，这里 re-export 保持既有调用方不变
export { countEntryChanges } from '../../../shared/diff/compute'
