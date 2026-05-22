/**
 * DiffViewer — 文件变更差异审查组件
 *
 * 职责：
 * 1. 展示单条消息关联的所有文件 diff（按文件分组）
 * 2. 绿色高亮新增行、红色高亮删除行
 * 3. 每个文件可独立展开/折叠
 * 4. 每个文件支持接受/拒绝操作
 * 5. 审查状态持久化：pending / accepted / rejected
 */
import React, { useState } from 'react'
import type { DiffEntry, DiffHunk } from '../../../shared/diff/types'
import { ChevronIcon, CheckIcon, UndoIcon } from '../../components/Icons'
import './DiffViewer.css'

export interface DiffViewerProps {
  diffs: DiffEntry[]
  reviews: Record<string, 'accepted' | 'rejected'>
  sessionId: string
  messageId: string
  isLoading?: boolean
  onRejectFile?: (filePath: string) => Promise<void>
  onAcceptFile?: (filePath: string) => Promise<void>
}

/** 单行 diff 渲染 */
const DiffLineView: React.FC<{
  prefix: string
  text: string
  realLineNo: number
}> = ({ prefix, text, realLineNo }) => {
  const type = prefix === '+' ? 'add' : prefix === '-' ? 'remove' : 'context'
  return (
    <div className={`diff-line diff-line--${type}`}>
      <span className="diff-line__no">{realLineNo || ''}</span>
      <span className="diff-line__text">{prefix}{text}</span>
    </div>
  )
}

/** 单个 hunk 的行渲染，使用真实的旧行/新行号 */
const HunkView: React.FC<{ hunk: DiffHunk }> = ({ hunk }) => {
  const lines = hunk.content.split('\n')
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart

  return (
    <div className="diff-hunk">
      <div className="diff-hunk__header">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      <div className="diff-hunk__content">
        {lines.map((line, idx) => {
          const prefix = line[0] || ' '
          const text = line.slice(1)
          let lineNo = 0

          if (prefix === ' ') {
            lineNo = oldLine
            oldLine++
            newLine++
          } else if (prefix === '+') {
            lineNo = newLine
            newLine++
          } else {
            lineNo = oldLine
            oldLine++
          }

          return (
            <DiffLineView key={idx} prefix={prefix} text={text} realLineNo={lineNo} />
          )
        })}
      </div>
    </div>
  )
}

/** 单个文件的 diff 面板 */
const FileDiffPanel: React.FC<{
  entry: DiffEntry
  reviewStatus: 'pending' | 'accepted' | 'rejected'
  onReject?: (filePath: string) => Promise<void>
  onAccept?: (filePath: string) => Promise<void>
}> = ({ entry, reviewStatus, onReject, onAccept }) => {
  const [expanded, setExpanded] = useState(reviewStatus === 'pending')
  const [rejecting, setRejecting] = useState(false)
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
    onAccept?.(entry.filePath)
  }

  // 已拒绝状态
  if (reviewStatus === 'rejected') {
    return (
      <div className="diff-file diff-file--rejected">
        <div className="diff-file__header">
          <ChevronIcon size={14} direction="right" />
          <span className="diff-file__name">{entry.filePath}</span>
          <span className="diff-file__status-badge">{statusLabel}</span>
          <span className="diff-file__review-badge diff-file__review-badge--rejected">已拒绝</span>
        </div>
      </div>
    )
  }

  // 已接受状态
  if (reviewStatus === 'accepted') {
    return (
      <div className="diff-file diff-file--accepted">
        <div className="diff-file__header" onClick={() => setExpanded(!expanded)}>
          <ChevronIcon size={14} direction={expanded ? 'down' : 'right'} />
          <span className="diff-file__name">{entry.filePath}</span>
          <span className="diff-file__status-badge">{statusLabel}</span>
          <span className="diff-file__review-badge diff-file__review-badge--accepted">已审查</span>
        </div>
        {expanded && (
          <div className="diff-file__body">
            {entry.hunks.map((hunk, idx) => (
              <HunkView key={idx} hunk={hunk} />
            ))}
          </div>
        )}
      </div>
    )
  }

  // 待审查状态
  return (
    <div className={`diff-file ${statusClass}`}>
      <div className="diff-file__header" onClick={() => setExpanded(!expanded)}>
        <ChevronIcon size={14} direction={expanded ? 'down' : 'right'} />
        <span className="diff-file__name">{entry.filePath}</span>
        <span className="diff-file__status-badge">{statusLabel}</span>
        <div className="diff-file__actions" onClick={e => e.stopPropagation()}>
          <button
            className="diff-action-btn diff-action-btn--accept"
            onClick={handleAccept}
            title="接受改动（标记为已审查）"
          >
            <CheckIcon size={13} />
          </button>
          <button
            className="diff-action-btn diff-action-btn--reject"
            onClick={handleReject}
            disabled={rejecting}
            title="拒绝改动（恢复原始文件）"
          >
            <UndoIcon size={13} />
          </button>
        </div>
      </div>

      {error && (
        <div className="diff-file__error">{error}</div>
      )}

      {expanded && (
        <div className="diff-file__body">
          {entry.hunks.map((hunk, idx) => (
            <HunkView key={idx} hunk={hunk} />
          ))}
        </div>
      )}
    </div>
  )
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  diffs,
  reviews,
  sessionId,
  messageId,
  isLoading = false,
  onRejectFile,
  onAcceptFile
}) => {
  const [expanded, setExpanded] = useState(true)

  // loading 状态
  if (isLoading) {
    return (
      <div className="diff-viewer">
        <div className="diff-viewer__header">
          <span className="diff-viewer__title">加载文件变更中...</span>
        </div>
      </div>
    )
  }

  if (!diffs || diffs.length === 0) return null

  const totalAdded = diffs.reduce(
    (sum, d) => sum + d.hunks.reduce(
      (s, h) => s + h.content.split('\n').filter(l => l.startsWith('+')).length, 0
    ), 0
  )
  const totalRemoved = diffs.reduce(
    (sum, d) => sum + d.hunks.reduce(
      (s, h) => s + h.content.split('\n').filter(l => l.startsWith('-')).length, 0
    ), 0
  )

  const pendingCount = diffs.filter(d => !reviews[d.filePath]).length
  const reviewedCount = diffs.length - pendingCount

  return (
    <div className="diff-viewer">
      <div className="diff-viewer__header" onClick={() => setExpanded(!expanded)}>
        <ChevronIcon size={14} direction={expanded ? 'down' : 'right'} />
        <span className="diff-viewer__title">文件变更审查</span>
        <span className="diff-viewer__stats">
          <span className="diff-viewer__stat diff-viewer__stat--added">+{totalAdded}</span>
          <span className="diff-viewer__stat diff-viewer__stat--removed">-{totalRemoved}</span>
          <span className="diff-viewer__stat diff-viewer__stat--files">{diffs.length} 个文件</span>
          {reviewedCount > 0 && (
            <span className="diff-viewer__stat diff-viewer__stat--reviewed">
              {reviewedCount}/{diffs.length} 已审
            </span>
          )}
        </span>
      </div>

      {expanded && (
        <div className="diff-viewer__body">
          {diffs.map((entry, idx) => (
            <FileDiffPanel
              key={idx}
              entry={entry}
              reviewStatus={reviews[entry.filePath] ?? 'pending'}
              onReject={onRejectFile}
              onAccept={onAcceptFile}
            />
          ))}
        </div>
      )}
    </div>
  )
}
