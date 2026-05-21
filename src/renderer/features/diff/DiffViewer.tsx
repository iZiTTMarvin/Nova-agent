/**
 * DiffViewer — 文件变更差异审查组件
 *
 * 职责：
 * 1. 展示单条消息关联的所有文件 diff（按文件分组）
 * 2. 绿色高亮新增行、红色高亮删除行
 * 3. 每个文件可独立展开/折叠
 * 4. 每个文件支持接受/拒绝操作
 */
import React, { useState } from 'react'
import type { DiffEntry } from '../../../shared/diff/types'
import { ChevronIcon, CheckIcon, UndoIcon } from '../../components/Icons'
import './DiffViewer.css'

interface DiffViewerProps {
  /** 该消息关联的所有文件 diff 列表 */
  diffs: DiffEntry[]
  /** 当前会话 ID */
  sessionId: string
  /** 当前消息 ID */
  messageId: string
  /** 拒绝文件后的回调 */
  onRejectFile?: (filePath: string) => void
  /** 接受文件后的回调 */
  onAcceptFile?: (filePath: string) => void
}

/** 单个文件的 diff 面板 */
const FileDiffPanel: React.FC<{
  entry: DiffEntry
  sessionId: string
  messageId: string
  onReject?: (filePath: string) => void
  onAccept?: (filePath: string) => void
}> = ({ entry, onReject, onAccept }) => {
  const [expanded, setExpanded] = useState(true)
  const [rejected, setRejected] = useState(false)

  const statusLabel = entry.status === 'added' ? '新建' : entry.status === 'deleted' ? '删除' : '修改'
  const statusClass = entry.status === 'added' ? 'diff-file--added' : entry.status === 'deleted' ? 'diff-file--deleted' : 'diff-file--modified'

  const handleReject = async () => {
    try {
      onReject?.(entry.filePath)
      setRejected(true)
    } catch (err) {
      console.error('拒绝文件失败:', err)
    }
  }

  const handleAccept = () => {
    onAccept?.(entry.filePath)
  }

  if (rejected) {
    return (
      <div className="diff-file diff-file--rejected">
        <div className="diff-file__header">
          <span className="diff-file__name">{entry.filePath}</span>
          <span className="diff-file__rejected-badge">已拒绝</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`diff-file ${statusClass}`}>
      <div className="diff-file__header" onClick={() => setExpanded(!expanded)}>
        <ChevronIcon size={14} direction={expanded ? 'down' : 'right'} />
        <span className="diff-file__name">{entry.filePath}</span>
        <span className="diff-file__status-badge">{statusLabel}</span>
        <div className="diff-file__actions" onClick={e => e.stopPropagation()}>
          <button className="diff-action-btn diff-action-btn--accept" onClick={handleAccept} title="接受改动">
            <CheckIcon size={13} />
          </button>
          <button className="diff-action-btn diff-action-btn--reject" onClick={handleReject} title="拒绝改动（恢复原始文件）">
            <UndoIcon size={13} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="diff-file__body">
          {entry.hunks.map((hunk, idx) => (
            <div key={idx} className="diff-hunk">
              <div className="diff-hunk__header">
                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
              </div>
              <pre className="diff-hunk__content">
                {hunk.content.split('\n').map((line, lineIdx) => (
                  <div key={lineIdx} className={`diff-line diff-line--${line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context'}`}>
                    <span className="diff-line__no">{lineIdx + 1}</span>
                    <span className="diff-line__text">{line}</span>
                  </div>
                ))}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ diffs, sessionId, messageId, onRejectFile, onAcceptFile }) => {
  const [expanded, setExpanded] = useState(true)

  if (!diffs || diffs.length === 0) return null

  const totalAdded = diffs.reduce((sum, d) => sum + d.hunks.reduce((s, h) => s + h.content.split('\n').filter(l => l.startsWith('+')).length, 0), 0)
  const totalRemoved = diffs.reduce((sum, d) => sum + d.hunks.reduce((s, h) => s + h.content.split('\n').filter(l => l.startsWith('-')).length, 0), 0)

  return (
    <div className="diff-viewer">
      <div className="diff-viewer__header" onClick={() => setExpanded(!expanded)}>
        <ChevronIcon size={14} direction={expanded ? 'down' : 'right'} />
        <span className="diff-viewer__title">文件变更审查</span>
        <span className="diff-viewer__stats">
          <span className="diff-viewer__stat diff-viewer__stat--added">+{totalAdded}</span>
          <span className="diff-viewer__stat diff-viewer__stat--removed">-{totalRemoved}</span>
          <span className="diff-viewer__stat diff-viewer__stat--files">{diffs.length} 个文件</span>
        </span>
      </div>

      {expanded && (
        <div className="diff-viewer__body">
          {diffs.map((entry, idx) => (
            <FileDiffPanel
              key={idx}
              entry={entry}
              sessionId={sessionId}
              messageId={messageId}
              onReject={onRejectFile}
              onAccept={onAcceptFile}
            />
          ))}
        </div>
      )}
    </div>
  )
}
