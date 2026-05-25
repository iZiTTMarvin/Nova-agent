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
import type { DiffEntry, DiffHunk, DiffReviewStatus } from '../../../shared/diff/types'
import { ChevronIcon, CheckIcon, UndoIcon } from '../../components/Icons'
import './DiffViewer.css'

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
  onRejectFile?: (filePath: string) => Promise<void>
  onAcceptFile?: (filePath: string) => Promise<void>
}

type TokenType =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'operator'
  | 'property'

interface DiffToken {
  text: string
  type: TokenType
}

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'switch', 'case', 'break', 'continue', 'class', 'interface', 'type', 'export',
  'import', 'from', 'async', 'await', 'new', 'try', 'catch', 'finally', 'throw',
  'extends', 'implements', 'public', 'private', 'protected', 'readonly', 'true',
  'false', 'null', 'undefined'
])

function detectLanguage(filePath: string): 'code' | 'json' | 'markdown' | 'shell' | 'plain' {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.md')) return 'markdown'
  if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.ps1')) return 'shell'
  if (
    lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.js') ||
    lower.endsWith('.jsx') || lower.endsWith('.css') || lower.endsWith('.html')
  ) {
    return 'code'
  }
  return 'plain'
}

function highlightLine(text: string, filePath: string): DiffToken[] {
  const language = detectLanguage(filePath)
  if (!text) return [{ text: '', type: 'plain' }]

  if (language === 'markdown') {
    if (/^\s*#{1,6}\s/.test(text)) return [{ text, type: 'keyword' }]
    if (/^\s*[-*]\s/.test(text)) return [{ text, type: 'operator' }]
    if (/^\s*>/.test(text)) return [{ text, type: 'comment' }]
    return [{ text, type: 'plain' }]
  }

  if (language === 'shell') {
    if (/^\s*#/.test(text)) return [{ text, type: 'comment' }]
  }

  const tokens: DiffToken[] = []
  const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b|\/\/.*|\/\*.*?\*\/|[:=+\-*/<>!&|()[\]{}.,])/g
  let lastIndex = 0

  for (const match of text.matchAll(pattern)) {
    const value = match[0]
    const index = match.index ?? 0
    if (index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, index), type: 'plain' })
    }

    let type: TokenType = 'plain'
    if (value.startsWith('//') || value.startsWith('/*') || (language === 'shell' && value.startsWith('#'))) {
      type = 'comment'
    } else if (
      value.startsWith('"') || value.startsWith("'") || value.startsWith('`')
    ) {
      type = 'string'
    } else if (/^\d/.test(value)) {
      type = 'number'
    } else if (KEYWORDS.has(value)) {
      type = 'keyword'
    } else if (/^[A-Za-z_]\w*$/.test(value) && language === 'json') {
      type = 'property'
    } else if (/^[:=+\-*/<>!&|()[\]{}.,]+$/.test(value)) {
      type = 'operator'
    }

    tokens.push({ text: value, type })
    lastIndex = index + value.length
  }

  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex), type: 'plain' })
  }

  return tokens.length > 0 ? tokens : [{ text, type: 'plain' }]
}

/** 单行 diff 渲染 */
const DiffLineView: React.FC<{
  prefix: string
  text: string
  realLineNo: number
  filePath: string
}> = ({ prefix, text, realLineNo, filePath }) => {
  const type = prefix === '+' ? 'add' : prefix === '-' ? 'remove' : 'context'
  const tokens = highlightLine(text, filePath)

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

/** 单个 hunk 的行渲染，使用真实的旧行/新行号 */
const HunkView: React.FC<{ hunk: DiffHunk; filePath: string }> = ({ hunk, filePath }) => {
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
            <DiffLineView key={idx} prefix={prefix} text={text} realLineNo={lineNo} filePath={filePath} />
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
      <div className="diff-file__header" onClick={() => setExpanded(!expanded)}>
        <ChevronIcon size={14} direction={expanded ? 'down' : 'right'} />
        <span className="diff-file__name">{entry.filePath}</span>
        <span className="diff-file__status-badge">{statusLabel}</span>
        <div className="diff-file__actions" onClick={e => e.stopPropagation()}>
          <button
            className="diff-action-btn diff-action-btn--accept"
            onClick={handleAccept}
            disabled={accepting || rejecting}
            title="接受改动（标记为已审查）"
          >
            <CheckIcon size={13} />
          </button>
          <button
            className="diff-action-btn diff-action-btn--reject"
            onClick={handleReject}
            disabled={accepting || rejecting}
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
            <HunkView key={idx} hunk={hunk} filePath={entry.filePath} />
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
  loadingPlaceholders,
  onRejectFile,
  onAcceptFile
}) => {
  const [expanded, setExpanded] = useState(true)

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
