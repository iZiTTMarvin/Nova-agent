/**
 * Inspector 审阅 Tab：以默认折叠的紧凑文件列表展示目标消息改动，点击文件行按需展开 Diff，支持单文件与整轮保留/回退。
 */
import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronIcon,
  CheckIcon,
  UndoIcon
} from '../../components/Icons'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useChatStore } from '../../stores/useChatStore'
import { useFileTreeStore } from './useFileTreeStore'
// 增删行统计的唯一实现在 shared/diff/compute；这里直接引用来源，
// 不再经由 diffLines —— 后者会连带把 pierre 高亮链路拖进首屏包。
import { countEntryChanges } from '../../../shared/diff/compute'
import type { DiffEntry } from '../../../shared/diff/types'
import type { MessageDiffCache } from '../../stores/types'
import { buildStatusDiffTurns } from '../session-status/statusModel'
import './InspectorPanel.css'

/** HunkView 依赖 pierre + shiki，走 lazy 使其不进入首屏包 */
const HunkView = lazy(() =>
  import('../diff/diffLines').then((m) => ({ default: m.HunkView }))
)
const DiffPoolContextBridge = lazy(() =>
  import('../diff/DiffPoolContextBridge').then((m) => ({ default: m.DiffPoolContextBridge }))
)

function splitPath(filePath: string): { dir: string; base: string } {
  const normalized = filePath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  if (idx === -1) return { dir: '', base: normalized }
  return { dir: normalized.slice(0, idx + 1), base: normalized.slice(idx + 1) }
}

function statusLabel(status: DiffEntry['status']): string {
  if (status === 'added') return '新建'
  if (status === 'deleted') return '删除'
  return '修改'
}

function statusClass(status: DiffEntry['status']): string {
  if (status === 'added') return 'diff-file--added'
  if (status === 'deleted') return 'diff-file--deleted'
  return 'diff-file--modified'
}

function findDerivedMessageId(
  messages: Array<{ id: string; role: string }>,
  messageDiffs: Record<string, MessageDiffCache>
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const cache = messageDiffs[msg.id]
    if (cache && cache.diffs.length > 0) return msg.id
  }
  return null
}

/** 没有 diff 时保留明确的空状态，避免把加载失败误认为空白。 */
const ReviewEmpty: React.FC = () => (
  <div className="inspector-empty">
    <p className="inspector-empty__hint">当前会话暂无可审阅的文件改动</p>
  </div>
)

/**
 * 精确订阅单条 messageId 的 diff 缓存与审查动作。
 * 默认将所有改动文件收起为紧凑单行，点击文件行再按需展开对应 diff。
 */
const ReviewContent: React.FC<{
  messageId: string
  preferredFilePath?: string
  localFileMode: boolean
}> = React.memo(({ messageId, preferredFilePath, localFileMode }) => {
  const diffCache = useChatStore(s => s.messageDiffs[messageId])
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const acceptFile = useChatStore(s => s.acceptFile)
  const rejectFile = useChatStore(s => s.rejectFile)
  const loadMessageDiffs = useChatStore(s => s.loadMessageDiffs)
  // stale 判定与消息卡片同一来源：灰显标记独立于可关闭的横幅，关闭横幅不解除安全禁用
  const tier1Stale = useChatStore(s => s.tier1StaleDiffMessageIds.includes(messageId))
  const selectReviewFile = useLayoutStore(s => s.selectReviewFile)

  /** 默认全部折叠为紧凑文件行，由用户点击按需展开 */
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({})
  const [focusedFilePath, setFocusedFilePath] = useState<string | null>(preferredFilePath ?? null)
  const [syntaxMode, setSyntaxMode] = useState<'syntax' | 'text'>('syntax')
  const [wrap, setWrap] = useState(false)
  const [busyFilePath, setBusyFilePath] = useState<string | null>(null)
  /** 最近一次保留/回退失败的就地提示 */
  const [actionError, setActionError] = useState<string | null>(null)
  /** diff 区外层滚动容器：大 hunk 虚拟化共享同一滚动条 */
  const bodyScrollRef = useRef<HTMLDivElement>(null)
  const fileRowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const refreshedDigestForMsgRef = useRef<string | null>(null)

  useEffect(() => {
    if (!currentSessionId) return
    if (!diffCache) {
      void loadMessageDiffs(currentSessionId, messageId)
      return
    }
    // 流式阶段结束时 diff:update 仅携带 hunks 而不含 currentDigest，
    // 首次进入审阅面板时补拉一次完整快照，避免点击回退时报“改动已过期”。
    const missingDigest =
      diffCache.diffs.length > 0 &&
      diffCache.diffs.some(d => d.currentDigest === undefined)
    if (
      missingDigest &&
      refreshedDigestForMsgRef.current !== messageId &&
      typeof window !== 'undefined' &&
      typeof window.api?.invoke === 'function'
    ) {
      refreshedDigestForMsgRef.current = messageId
      void loadMessageDiffs(currentSessionId, messageId, true)
    }
  }, [diffCache, currentSessionId, messageId, loadMessageDiffs])

  useEffect(() => {
    if (!preferredFilePath) return
    setFocusedFilePath(preferredFilePath)
    const rowEl = fileRowRefs.current[preferredFilePath]
    if (rowEl && typeof rowEl.scrollIntoView === 'function') {
      rowEl.scrollIntoView({ block: 'nearest' })
    }
  }, [preferredFilePath])

  const diffs = diffCache?.diffs ?? []
  const reviews = diffCache?.reviews ?? {}

  const totals = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const entry of diffs) {
      const count = countEntryChanges(entry)
      additions += count.additions
      deletions += count.deletions
    }
    return { additions, deletions }
  }, [diffs])

  const allExpanded = useMemo(
    () => diffs.length > 0 && diffs.every(d => expandedFiles[d.filePath]),
    [diffs, expandedFiles]
  )

  const toggleFileExpand = (filePath: string) => {
    setFocusedFilePath(filePath)
    if (!localFileMode) {
      selectReviewFile(filePath)
    }
    setExpandedFiles(prev => ({
      ...prev,
      [filePath]: !prev[filePath]
    }))
  }

  const toggleExpandAll = () => {
    if (allExpanded) {
      setExpandedFiles({})
      return
    }
    const next: Record<string, boolean> = {}
    for (const entry of diffs) {
      next[entry.filePath] = true
    }
    setExpandedFiles(next)
  }

  const handleAccept = async (filePath: string) => {
    if (!currentSessionId || tier1Stale || busyFilePath) return
    setBusyFilePath(filePath)
    setActionError(null)
    try {
      await acceptFile(currentSessionId, messageId, filePath)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '保留失败')
    } finally {
      setBusyFilePath(null)
    }
  }

  const handleReject = async (filePath: string) => {
    if (!currentSessionId || tier1Stale || busyFilePath) return
    setBusyFilePath(filePath)
    setActionError(null)
    try {
      await rejectFile(currentSessionId, messageId, filePath)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '回退失败')
    } finally {
      setBusyFilePath(null)
    }
  }

  if (!diffCache) {
    return (
      <div className="inspector-empty">
        <p className="inspector-empty__hint">正在加载文件变更…</p>
      </div>
    )
  }

  if (diffs.length === 0) {
    return diffCache.skippedFiles?.length ? (
      <div className="inspector-empty">
        <p>以下文件未生成快照，无法回退</p>
        {diffCache.skippedFiles.map(file => <p key={file.path}>{file.path}</p>)}
      </div>
    ) : <ReviewEmpty />
  }

  const reviewedCount = diffs.filter(d => reviews[d.filePath]).length
  const actionsDisabled = Boolean(busyFilePath) || tier1Stale || !currentSessionId

  return (
    <div className={`inspector-review${tier1Stale ? ' inspector-review--stale' : ''}`}>
      <div className="inspector-review__toolbar">
        <div className="inspector-review__summary">
          <span className="inspector-review__summary-count">{diffs.length} 个文件</span>
          <span className="diff-file__changes">
            <span className="diff-file__changes-add">+{totals.additions}</span>
            <span className="diff-file__changes-del">-{totals.deletions}</span>
          </span>
          <span className="inspector-review__summary-progress">
            已审 {reviewedCount}/{diffs.length}
          </span>
        </div>
        <div className="inspector-review__toggles">
          <button
            type="button"
            className={`inspector-toggle${allExpanded ? ' inspector-toggle--on' : ''}`}
            onClick={toggleExpandAll}
          >
            {allExpanded ? '全部收起' : '全部展开'}
          </button>
          <div className="inspector-segment" role="group" aria-label="高亮模式">
            <button
              type="button"
              className={`inspector-segment__btn${syntaxMode === 'syntax' ? ' inspector-segment__btn--active' : ''}`}
              onClick={() => setSyntaxMode('syntax')}
            >
              语法
            </button>
            <button
              type="button"
              className={`inspector-segment__btn${syntaxMode === 'text' ? ' inspector-segment__btn--active' : ''}`}
              onClick={() => setSyntaxMode('text')}
            >
              文本
            </button>
          </div>
          <button
            type="button"
            className={`inspector-toggle${wrap ? ' inspector-toggle--on' : ''}`}
            aria-pressed={wrap}
            onClick={() => setWrap(v => !v)}
          >
            换行
          </button>
        </div>
      </div>

      {tier1Stale && (
        <div className="inspector-review__stale-banner" title="此消息的文件改动未同步到当前工作区，以下 diff 仅作历史参考">
          工作区未同步，仅作历史参考
        </div>
      )}

      {actionError && (
        <div className="inspector-review__error" role="alert">
          {actionError}
        </div>
      )}
      {!!diffCache.skippedFiles?.length && (
        <div className="inspector-review__stale-banner">
          以下文件未生成快照，无法回退：{diffCache.skippedFiles.map(file => file.path).join('、')}
        </div>
      )}

      <div className="inspector-review__body" ref={bodyScrollRef}>
        <div className="inspector-review__list">
          {diffs.map((entry) => {
            const { dir, base } = splitPath(entry.filePath)
            const { additions, deletions } = countEntryChanges(entry)
            const reviewStatus = reviews[entry.filePath]
            const isExpanded = Boolean(expandedFiles[entry.filePath])
            const isFocused = focusedFilePath === entry.filePath
            const isFileBusy = busyFilePath === entry.filePath

            return (
              <div
                key={entry.filePath}
                ref={(el) => {
                  fileRowRefs.current[entry.filePath] = el
                }}
                className={[
                  'inspector-review__file-item',
                  isExpanded ? 'inspector-review__file-item--expanded' : '',
                  isFocused ? 'inspector-review__file-item--focused' : ''
                ].filter(Boolean).join(' ')}
              >
                <div
                  className="inspector-review__file-header"
                  onClick={() => toggleFileExpand(entry.filePath)}
                >
                  <button
                    type="button"
                    className="inspector-review__file-trigger"
                    aria-expanded={isExpanded}
                    title={entry.filePath}
                  >
                    <ChevronIcon
                      size={13}
                      direction={isExpanded ? 'down' : 'right'}
                      className="inspector-review__file-chevron"
                    />
                    <div className="inspector-review__path">
                      <span className="inspector-review__base">{base}</span>
                      {dir ? <span className="inspector-review__dir">{dir.replace(/\/$/, '')}</span> : null}
                    </div>
                  </button>

                  <div
                    className="inspector-review__file-meta"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className={statusClass(entry.status)}>
                      <span className="diff-file__status-badge">{statusLabel(entry.status)}</span>
                    </span>
                    <span className="diff-file__changes">
                      <span className="diff-file__changes-add">+{additions}</span>
                      <span className="diff-file__changes-del">-{deletions}</span>
                    </span>
                    {entry.status !== 'deleted' && (
                      <button
                        type="button"
                        className="inspector-review__row-btn"
                        title="在文件面板查看完整文件"
                        onClick={() => {
                          useLayoutStore.getState().openFiles()
                          useFileTreeStore.getState().selectFile(entry.filePath)
                        }}
                      >
                        打开
                      </button>
                    )}
                    {reviewStatus === 'accepted' ? (
                      <span className="diff-file__review-badge diff-file__review-badge--accepted">已审查</span>
                    ) : reviewStatus === 'rejected' ? (
                      <span className="diff-file__review-badge diff-file__review-badge--rejected">已拒绝</span>
                    ) : (
                      <div className="inspector-review__file-actions">
                        <button
                          type="button"
                          className="inspector-review__row-btn inspector-review__row-btn--reject"
                          disabled={actionsDisabled}
                          title="回退此文件改动"
                          onClick={() => void handleReject(entry.filePath)}
                        >
                          <UndoIcon size={12} />
                          <span>{isFileBusy ? '处理中' : '回退'}</span>
                        </button>
                        <button
                          type="button"
                          className="inspector-review__row-btn inspector-review__row-btn--accept"
                          disabled={actionsDisabled}
                          title="保留此文件改动"
                          onClick={() => void handleAccept(entry.filePath)}
                        >
                          <CheckIcon size={12} />
                          <span>保留</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <div className="inspector-review__file-diff">
                    {entry.hunks.length > 0 ? (
                      <Suspense fallback={<div className="diff-hunk__pending">正在准备差异视图…</div>}>
                        <DiffPoolContextBridge>
                          {entry.hunks.map((hunk, idx) => (
                            <HunkView
                              key={`${entry.filePath}:${idx}`}
                              hunk={hunk}
                              filePath={entry.filePath}
                              status={entry.status}
                              syntaxHighlight={syntaxMode === 'syntax'}
                              wrap={wrap}
                              scrollRef={bodyScrollRef}
                            />
                          ))}
                        </DiffPoolContextBridge>
                      </Suspense>
                    ) : (
                      <div className="inspector-review__file-empty">此文件无文本差异可展示</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
})

function ReviewTurnActions({ messageId }: { messageId: string }) {
  const sessionId = useChatStore(state => state.currentSessionId)
  const cache = useChatStore(state => state.messageDiffs[messageId])
  const stale = useChatStore(state => state.tier1StaleDiffMessageIds.includes(messageId))
  const acceptAll = useChatStore(state => state.acceptAllFiles)
  const rejectAll = useChatStore(state => state.rejectAllFiles)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = cache?.diffs.filter(diff => !cache.reviews[diff.filePath]).map(diff => diff.filePath) ?? []
  const apply = async (reject: boolean) => {
    if (!sessionId || stale || busy || pending.length === 0) return
    setBusy(true)
    setError(null)
    try {
      if (reject) {
        const result = await rejectAll(sessionId, messageId, pending)
        if (result.failed.length > 0) setError(`部分文件回退失败：${result.failed.map(file => file.filePath).join('、')}`)
      } else await acceptAll(sessionId, messageId, pending)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return pending.length > 0 ? (
    <div className="inspector-review__turn-actions">
      <span className="inspector-review__turn-hint">待审 {pending.length} 个文件</span>
      <div className="inspector-review__turn-btns">
        <button
          type="button"
          className="inspector-review__batch-btn inspector-review__batch-btn--reject"
          disabled={busy || stale}
          onClick={() => void apply(true)}
        >
          <UndoIcon size={12} />
          <span>撤销本轮待审改动</span>
        </button>
        <button
          type="button"
          className="inspector-review__batch-btn inspector-review__batch-btn--accept"
          disabled={busy || stale}
          onClick={() => void apply(false)}
        >
          <CheckIcon size={12} />
          <span>标记全部已审</span>
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  ) : null
}

export const ReviewTab: React.FC = () => {
  const reviewTarget = useLayoutStore(s => s.reviewTarget)
  const openReview = useLayoutStore(s => s.openReview)
  const messages = useChatStore(s => s.messages)
  const messageDiffs = useChatStore(s => s.messageDiffs)
  const placeholders = useChatStore(s => s.loadingDiffPlaceholders)
  const sessionId = useChatStore(s => s.currentSessionId)
  const turns = useMemo(
    () => buildStatusDiffTurns(messages, sessionId ?? '', messageDiffs, placeholders),
    [messages, sessionId, messageDiffs, placeholders]
  )
  const derivedMessageId = useMemo(
    () => turns[0]?.messageId ?? findDerivedMessageId(messages, messageDiffs),
    [turns, messages, messageDiffs]
  )
  // 若 reviewTarget 指向跨会话遗留消息（当前会话有消息但并不包含该 messageId），自动回退到当前会话最新改动轮次
  const validTargetMessageId = useMemo(() => {
    if (!reviewTarget?.messageId) return null
    if (messages.length === 0) return reviewTarget.messageId
    const inCurrentMessages = messages.some(m => m.id === reviewTarget.messageId)
    const inCurrentTurns = turns.some(t => t.messageId === reviewTarget.messageId)
    if (inCurrentMessages || inCurrentTurns) return reviewTarget.messageId
    return derivedMessageId ?? reviewTarget.messageId
  }, [reviewTarget, messages, turns, derivedMessageId])

  const messageId = validTargetMessageId ?? derivedMessageId
  if (!messageId) return <ReviewEmpty />
  return (
    <div className="inspector-review__turn">
      {turns.length > 1 && (
        <div className="inspector-review__turn-picker">
          <select
            aria-label="审阅轮次"
            value={messageId}
            onChange={event => openReview({ messageId: event.target.value })}
          >
            {turns.map((turn, index) => (
              <option key={turn.messageId} value={turn.messageId}>
                {index === 0 ? '最近改动：' : ''}{turn.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <ReviewContent
        key={messageId}
        messageId={messageId}
        preferredFilePath={reviewTarget?.filePath}
        localFileMode={!reviewTarget}
      />
      <ReviewTurnActions key={`actions-${messageId}`} messageId={messageId} />
    </div>
  )
}
