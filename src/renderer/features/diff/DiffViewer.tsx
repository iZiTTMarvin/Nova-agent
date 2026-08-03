/**
 * DiffViewer — 文件变更差异审查组件
 *
 * 职责：
 * 1. 展示单条消息关联的所有文件 diff（按文件分组）
 * 2. 绿色高亮新增行、红色高亮删除行
 * 3. 每个文件可独立展开/折叠
 * 4. 每个文件支持接受/拒绝操作
 * 5. 审查状态持久化：pending / accepted / rejected
 * 6. PRD §5.3：批量审阅（全部接受 / 全部拒绝 / 只看未审阅 / 按目录折叠）
 */
import React, { useMemo, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { IconButton } from '@astryxdesign/core/IconButton'
import type { DiffEntry, DiffHunk, DiffReviewStatus, SkippedFileInfo } from '../../../shared/diff/types'
import { ChevronIcon, CheckIcon, UndoIcon } from '../../components/Icons'
import { highlightLine } from './syntaxHighlight'
import { highlightLineCached } from '../../lib/highlightCache'
import './DiffViewer.css'

/** T04：单个 hunk 超过此行数时截断展示 */
const PREVIEW_HUNK_LINE_LIMIT = 500

/** 合并卡片文件列表默认展示行数，超出折叠到「再显示 N 个文件」 */
const FILE_LIST_PREVIEW_COUNT = 3

export interface DiffViewerProps {
  diffs: DiffEntry[]
  reviews: Record<string, DiffReviewStatus>
  sessionId: string
  messageId: string
  isLoading?: boolean
  /**
   * loading 阶段的占位文件列表。
   * 后端已经知道有哪些文件被改动，但还没算完 LCS，所以这里先把文件名展示出来，
   * 用 spinner 表达「正在加载详细差异」。
   */
  loadingPlaceholders?: Array<{ filePath: string; status: DiffEntry['status'] }>
  /** 因过大或命中排除规则而跳过备份的文件 */
  skippedFiles?: SkippedFileInfo[]
  /** Tier 1：工作区未重放此分支改动，diff 仅历史展示、不可审阅 */
  tier1Stale?: boolean
  onRejectFile?: (filePath: string) => Promise<void>
  onAcceptFile?: (filePath: string) => Promise<void>
  /** PRD §5.3：批量接受（接受全部 pending 文件） */
  onAcceptAll?: (filePaths: string[]) => Promise<void>
  /** PRD §5.3：批量拒绝（拒绝全部 pending 文件，从 checkpoint 恢复），返回恢复成功与失败的文件 */
  onRejectAll?: (filePaths: string[]) => Promise<{ restored: string[]; failed: Array<{ filePath: string; error: string }> }>
}

/** 单行 diff 渲染 */
const DiffLineView: React.FC<{
  prefix: string
  text: string
  realLineNo: number
  filePath: string
}> = ({ prefix, text, realLineNo, filePath }) => {
  const type = prefix === '+' ? 'add' : prefix === '-' ? 'remove' : 'context'
  // T13：通过缓存层调用 highlightLine，避免重复计算
  const tokens = highlightLineCached(text, filePath, highlightLine)

  return (
    <div className={`diff-line diff-line--${type}`}>
      <span className="diff-line__no">{realLineNo || ''}</span>
      <span className="diff-line__text">
        <span className="diff-line__prefix">{prefix}</span>
        {tokens.map((token, idx) => (
          <span key={idx} className={`diff-token diff-token--${token.type}`}>{token.text}</span>
        ))}
      </span>
    </div>
  )
}

/** 预计算单行 diff 信息，避免 VList 渲染时依赖递增状态 */
interface ComputedDiffLine {
  prefix: string
  text: string
  realLineNo: number
}

/** 从 hunk content 预计算所有行的 diff 信息 */
function computeDiffLines(hunk: DiffHunk): ComputedDiffLine[] {
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

/** Hunk 渲染。大 hunk 截断展示，保留行级直接渲染 */
const HunkView: React.FC<{ hunk: DiffHunk; filePath: string }> = ({ hunk, filePath }) => {
  const allLines = useMemo(() => computeDiffLines(hunk), [hunk])
  const needsTruncation = allLines.length > PREVIEW_HUNK_LINE_LIMIT
  const [showFull, setShowFull] = useState(false)
  const displayLines = showFull ? allLines : allLines.slice(0, PREVIEW_HUNK_LINE_LIMIT)

  return (
    <div className="diff-hunk">
      <div className="diff-hunk__header">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      <div className="diff-hunk__content">
        {displayLines.map((line, idx) => (
          <DiffLineView key={idx} prefix={line.prefix} text={line.text} realLineNo={line.realLineNo} filePath={filePath} />
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
function countEntryChanges(entry: DiffEntry): { additions: number; deletions: number } {
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

/** 单文件增删统计（对齐 Codex 合并卡片的文件行右侧 +N -N） */
const FileChangeStats: React.FC<{ entry: DiffEntry }> = ({ entry }) => {
  const { additions, deletions } = countEntryChanges(entry)
  return (
    <span className="diff-file__changes">
      <span className="diff-file__changes-add">+{additions}</span>
      <span className="diff-file__changes-del">-{deletions}</span>
    </span>
  )
}

/** 单个文件的 diff 面板 */
const FileDiffPanel: React.FC<{
  entry: DiffEntry
  reviewStatus: 'pending' | 'accepted' | 'rejected'
  onReject?: (filePath: string) => Promise<void>
  onAccept?: (filePath: string) => Promise<void>
}> = ({ entry, reviewStatus, onReject, onAccept }) => {
  // 默认折叠为文件行，点击展开查看具体 diff（合并卡片内保持紧凑）
  const [expanded, setExpanded] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const statusLabel = entry.status === 'added' ? '新建' : entry.status === 'deleted' ? '删除' : '修改'
  const statusClass = entry.status === 'added' ? 'diff-file--added' : entry.status === 'deleted' ? 'diff-file--deleted' : 'diff-file--modified'

  const handleReject = async () => {
    setRejecting(true)
    setError(null)
    try {
      await onReject?.(entry.filePath)
    } catch (err) {
      setError('拒绝失败，文件未能恢复')
    } finally {
      setRejecting(false)
    }
  }

  const handleAccept = () => {
    void (async () => {
      setAccepting(true)
      setError(null)
      try {
        await onAccept?.(entry.filePath)
      } catch (err) {
        setError('接受失败，未能更新审查状态')
      } finally {
        setAccepting(false)
      }
    })()
  }

  // 已拒绝状态
  if (reviewStatus === 'rejected') {
    return (
      <div className="diff-file diff-file--rejected">
        <div className="diff-file__header">
          <ChevronIcon size={14} direction="right" />
          <span className="diff-file__name">{entry.filePath}</span>
          <span className="diff-file__status-badge">{statusLabel}</span>
          <FileChangeStats entry={entry} />
          <span className="diff-file__review-badge diff-file__review-badge--rejected">已拒绝</span>
        </div>
      </div>
    )
  }

  // 已接受状态
  if (reviewStatus === 'accepted') {
    return (
      <div className="diff-file diff-file--accepted">
        <div
          className="diff-file__header"
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setExpanded(value => !value)
            }
          }}
        >
          <ChevronIcon size={14} direction={expanded ? 'down' : 'right'} />
          <span className="diff-file__name">{entry.filePath}</span>
          <span className="diff-file__status-badge">{statusLabel}</span>
          <FileChangeStats entry={entry} />
          <span className="diff-file__review-badge diff-file__review-badge--accepted">已审查</span>
        </div>
        {expanded && (
          <div className="diff-file__body">
            {entry.hunks.map((hunk, idx) => (
              <HunkView key={idx} hunk={hunk} filePath={entry.filePath} />
            ))}
          </div>
        )}
      </div>
    )
  }

  // 待审查状态
  return (
    <div className={`diff-file ${statusClass}`}>
        <div
          className="diff-file__header"
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setExpanded(value => !value)
            }
          }}
        >
        <ChevronIcon size={14} direction={expanded ? 'down' : 'right'} />
        <span className="diff-file__name">{entry.filePath}</span>
        <span className="diff-file__status-badge">{statusLabel}</span>
        <FileChangeStats entry={entry} />
        <div
          className="diff-file__actions"
          onClick={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
        >
          <IconButton
            label="接受改动（标记为已审查）"
            icon={<CheckIcon size={13} />}
            variant="ghost"
            size="sm"
            className="diff-action-btn diff-action-btn--accept"
            onClick={handleAccept}
            isDisabled={accepting || rejecting}
            tooltip="接受改动（标记为已审查）"
          />
          <IconButton
            label="拒绝改动（恢复原始文件）"
            icon={<UndoIcon size={13} />}
            variant="ghost"
            size="sm"
            className="diff-action-btn diff-action-btn--reject"
            onClick={handleReject}
            isDisabled={accepting || rejecting}
            tooltip="拒绝改动（恢复原始文件）"
          />
        </div>
      </div>

      {error && (
        <div className="diff-file__error">{error}</div>
      )}

      {expanded && (
        <div className="diff-file__body">
          {entry.hunks.map((hunk, idx) => (
            <HunkView key={idx} hunk={hunk} filePath={entry.filePath} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 取文件路径的首段作为目录分组键 */
function dirOf(filePath: string): string {
  const idx = filePath.indexOf('/')
  if (idx === -1) {
    // Windows 路径
    const idx2 = filePath.indexOf('\\')
    return idx2 === -1 ? '(根目录)' : filePath.slice(0, idx2)
  }
  return filePath.slice(0, idx)
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  diffs,
  reviews,
  sessionId,
  messageId,
  isLoading = false,
  loadingPlaceholders,
  skippedFiles,
  tier1Stale = false,
  onRejectFile,
  onAcceptFile,
  onAcceptAll,
  onRejectAll
}) => {
  const hasSkippedFiles = skippedFiles && skippedFiles.length > 0
  // PRD §5.3：只看未审阅
  const [onlyPending, setOnlyPending] = useState(false)
  // PRD §5.3：按目录折叠
  const [groupByDir, setGroupByDir] = useState(false)
  // 文件列表默认只展示前几行，点「再显示 N 个文件」展开全部
  const [showAllFiles, setShowAllFiles] = useState(false)
  // 批量操作进行中
  const [batching, setBatching] = useState(false)
  const [batchError, setBatchError] = useState<string | null>(null)

  // loading 状态：展示已知文件名 + spinner，不展示 +0 -0 统计避免误导
  if (isLoading) {
    const placeholders = loadingPlaceholders ?? []
    return (
      <div className="diff-viewer diff-viewer--loading">
        <div className="diff-viewer__header">
          <span className="diff-viewer__title">正在加载文件变更…</span>
          {placeholders.length > 0 && (
            <span className="diff-viewer__stats">
              <span className="diff-viewer__stat diff-viewer__stat--files">{placeholders.length} 个文件</span>
            </span>
          )}
        </div>
        {placeholders.length > 0 && (
          <div className="diff-viewer__body">
            {placeholders.map((file, idx) => {
              const statusLabel = file.status === 'added' ? '新建' : file.status === 'deleted' ? '删除' : '修改'
              return (
                <div key={`${file.filePath}_${idx}`} className="diff-file diff-file--loading">
                  <div className="diff-file__header">
                    <ChevronIcon size={14} direction="right" />
                    <span className="diff-file__name">{file.filePath}</span>
                    <span className="diff-file__status-badge">{statusLabel}</span>
                    <span className="diff-file__loading-spinner" aria-label="loading">…</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  if ((!diffs || diffs.length === 0) && !hasSkippedFiles) return null

  const { totalAdded, totalRemoved } = diffs.reduce(
    (acc, d) => {
      const changes = countEntryChanges(d)
      acc.totalAdded += changes.additions
      acc.totalRemoved += changes.deletions
      return acc
    },
    { totalAdded: 0, totalRemoved: 0 }
  )

  const pendingFiles = diffs.filter(d => !reviews[d.filePath])
  const pendingCount = pendingFiles.length
  const reviewedCount = diffs.length - pendingCount

  // 应用过滤：只看未审阅
  const visibleDiffs = onlyPending ? pendingFiles : diffs

  // 批量接受所有 pending 文件
  const handleAcceptAll = async () => {
    if (!onAcceptAll || pendingCount === 0) return
    setBatching(true)
    setBatchError(null)
    try {
      await onAcceptAll(pendingFiles.map(d => d.filePath))
    } catch (err) {
      setBatchError('批量接受失败')
    } finally {
      setBatching(false)
    }
  }

  // 批量拒绝所有 pending 文件
  const handleRejectAll = async () => {
    if (!onRejectAll || pendingCount === 0) return
    setBatching(true)
    setBatchError(null)
    try {
      const result = await onRejectAll(pendingFiles.map(d => d.filePath))
      if (result.failed.length > 0) {
        setBatchError(`${result.failed.length} 个文件拒绝失败：${result.failed.map(f => f.filePath).join(', ')}`)
      }
    } catch (err) {
      setBatchError('批量拒绝失败')
    } finally {
      setBatching(false)
    }
  }

  // 渲染单个文件面板
  const renderFile = (entry: DiffEntry) => (
    <FileDiffPanel
      key={entry.filePath}
      entry={entry}
      reviewStatus={reviews[entry.filePath] ?? 'pending'}
      onReject={onRejectFile}
      onAccept={onAcceptFile}
    />
  )

  // 文件列表默认收起为前几行（目录分组模式始终全量展示）
  const capped = !groupByDir && !showAllFiles && visibleDiffs.length > FILE_LIST_PREVIEW_COUNT
  const listedDiffs = capped ? visibleDiffs.slice(0, FILE_LIST_PREVIEW_COUNT) : visibleDiffs

  return (
    <div className={`diff-viewer${tier1Stale ? ' diff-viewer--tier1-stale' : ''}`} title={tier1Stale ? '此消息的文件改动未同步到当前工作区，以下 diff 仅作历史参考' : undefined}>
      <div className="diff-viewer__header">
        <span className="diff-viewer__title">
          {tier1Stale ? '文件变更（历史记录，工作区未同步）' : `已编辑 ${diffs.length} 个文件`}
        </span>
        {reviewedCount > 0 && (
          <span className="diff-viewer__stat diff-viewer__stat--reviewed">
            {reviewedCount}/{diffs.length} 已审
          </span>
        )}
        <span className="diff-viewer__stats">
          <span className="diff-viewer__stat diff-viewer__stat--added">+{totalAdded}</span>
          <span className="diff-viewer__stat diff-viewer__stat--removed">-{totalRemoved}</span>
        </span>
        {pendingCount > 0 && (onAcceptAll || onRejectAll) && (
          <div className="diff-viewer__header-actions">
            {onRejectAll && (
              <Button
                label="撤销"
                variant="secondary"
                size="sm"
                className="diff-header-btn"
                onClick={() => void handleRejectAll()}
                isDisabled={batching}
                tooltip={`撤销全部 ${pendingCount} 个待审阅文件（从 checkpoint 恢复原始内容）`}
              >
                撤销
              </Button>
            )}
            {onAcceptAll && (
              <Button
                label="接受"
                variant="primary"
                size="sm"
                className="diff-header-btn diff-header-btn--primary"
                onClick={() => void handleAcceptAll()}
                isDisabled={batching}
                tooltip={`接受全部 ${pendingCount} 个待审阅文件（标记为已审查）`}
              >
                接受
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="diff-viewer__body">
          {/* WS1.1：标记因过大或排除规则未生成 snapshot 的文件 */}
          {skippedFiles && skippedFiles.length > 0 && (
            <div className="diff-viewer__skipped">
              <div className="diff-viewer__skipped-header">
                <span className="diff-viewer__skipped-icon">!</span>
                <span>以下文件未生成快照（无法回退/拒绝恢复）</span>
                <span className="diff-viewer__skipped-count">{skippedFiles.length} 个</span>
              </div>
              <div className="diff-viewer__skipped-list">
                {skippedFiles.map(file => (
                  <div key={file.path} className="diff-viewer__skipped-item" title={file.reason === 'oversized' ? `文件大小 ${formatBytes(file.bytes)}，超过备份上限` : '命中排除规则'}>
                    <span className="diff-viewer__skipped-name">{file.path}</span>
                    <span className="diff-viewer__skipped-reason">
                      {file.reason === 'oversized' ? `过大 ${formatBytes(file.bytes)}` : '排除规则'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* PRD §5.3：过滤开关（批量撤销/接受已上移到卡片头部） */}
          {diffs.length > 1 && (
            <div className="diff-viewer__toolbar">
              <CheckboxInput
                label="只看未审阅"
                value={onlyPending}
                size="sm"
                className="diff-toolbar__toggle"
                onChange={checked => setOnlyPending(checked)}
              />
              <CheckboxInput
                label="按目录折叠"
                value={groupByDir}
                size="sm"
                className="diff-toolbar__toggle"
                onChange={checked => setGroupByDir(checked)}
              />
            </div>
          )}

          {/* PRD §5.3：只看未审阅时若没有 pending 文件，给出提示 */}
          {onlyPending && visibleDiffs.length === 0 && (
            <div className="diff-viewer__empty">没有待审阅的文件</div>
          )}

          {batchError && <div className="diff-viewer__batch-error">{batchError}</div>}

          {/* PRD §5.3：按目录分组渲染 */}
          {groupByDir ? (
            <div className="diff-viewer__groups">
              {Object.entries(
                visibleDiffs.reduce<Record<string, DiffEntry[]>>((acc, entry) => {
                  const key = dirOf(entry.filePath)
                  ;(acc[key] ??= []).push(entry)
                  return acc
                }, {})
              ).map(([dir, entries]) => (
                <DiffDirGroup key={dir} dir={dir} entries={entries}>
                  {entries.map(renderFile)}
                </DiffDirGroup>
              ))}
            </div>
          ) : (
            <>
              {listedDiffs.map(renderFile)}
              {capped && (
                <Button
                  label={`再显示 ${visibleDiffs.length - FILE_LIST_PREVIEW_COUNT} 个文件`}
                  variant="ghost"
                  size="sm"
                  className="diff-viewer__show-more"
                  onClick={() => setShowAllFiles(true)}
                  endContent={<ChevronIcon size={12} direction="down" />}
                />
              )}
            </>
          )}
      </div>
    </div>
  )
}

/** 将字节数格式化为可读字符串 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

/** 按目录分组的小折叠面板 */
const DiffDirGroup: React.FC<{ dir: string; entries: DiffEntry[]; children: React.ReactNode }> = ({ dir, entries, children }) => {
  const [open, setOpen] = useState(true)
  return (
    <div className="diff-dir-group">
      <div
        className="diff-dir-group__header"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen(value => !value)
          }
        }}
      >
        <ChevronIcon size={13} direction={open ? 'down' : 'right'} />
        <span className="diff-dir-group__name">{dir}</span>
        <span className="diff-dir-group__count">{entries.length}</span>
      </div>
      {open && <div className="diff-dir-group__body">{children}</div>}
    </div>
  )
}
