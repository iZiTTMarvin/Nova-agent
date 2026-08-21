/**
 * Inspector 审阅 Tab：展示目标消息的文件 diff，支持逐文件保留/回退。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import {
  ChevronIcon,
  CheckIcon,
  UndoIcon,
  InfoIcon
} from '../../components/Icons'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useChatStore } from '../../stores/useChatStore'
import { countEntryChanges, HunkView } from '../diff/diffLines'
import type { DiffEntry } from '../../../shared/diff/types'
import type { MessageDiffCache } from '../../stores/types'
import './InspectorPanel.css'

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

const ReviewEmpty: React.FC = () => (
  <div className="inspector-empty">
    <InfoIcon size={28} />
    <p className="inspector-empty__title">暂无可审查的文件变更</p>
    <p className="inspector-empty__hint">点击卡片中的文件即可在此审查</p>
  </div>
)

/**
 * 精确订阅单条 messageId 的 diff 缓存与审查动作。
 * memo 隔离外层 messages/messageDiffs 根订阅：流式 delta 更新 messages 时
 * props（原始值）不变，审查区不跟随重渲染。
 */
const ReviewContent: React.FC<{
  messageId: string
  preferredFilePath?: string
  /** 无 store reviewTarget 时用本地文件选择，不写回 layout store */
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

  const [localFilePath, setLocalFilePath] = useState<string | null>(null)
  const [syntaxMode, setSyntaxMode] = useState<'syntax' | 'text'>('syntax')
  const [wrap, setWrap] = useState(false)
  const [busy, setBusy] = useState(false)
  /** diff 区外层滚动容器：大 hunk 虚拟化共享同一滚动条 */
  const bodyScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!diffCache && currentSessionId) {
      void loadMessageDiffs(currentSessionId, messageId)
    }
  }, [diffCache, currentSessionId, messageId, loadMessageDiffs])

  const diffs = diffCache?.diffs ?? []
  const reviews = diffCache?.reviews ?? {}

  const currentFilePath = useMemo(() => {
    if (diffs.length === 0) return null
    const preferred = localFileMode
      ? (localFilePath ?? preferredFilePath)
      : (preferredFilePath ?? localFilePath)
    if (preferred && diffs.some(d => d.filePath === preferred)) return preferred
    return diffs[0].filePath
  }, [diffs, preferredFilePath, localFilePath, localFileMode])

  const currentIndex = currentFilePath
    ? diffs.findIndex(d => d.filePath === currentFilePath)
    : -1
  const currentEntry = currentIndex >= 0 ? diffs[currentIndex] : null
  const reviewStatus = currentFilePath ? reviews[currentFilePath] : undefined

  const goFile = (delta: number) => {
    if (diffs.length === 0 || currentIndex < 0) return
    const next = currentIndex + delta
    if (next < 0 || next >= diffs.length) return
    const path = diffs[next].filePath
    if (localFileMode) {
      setLocalFilePath(path)
    } else {
      selectReviewFile(path)
    }
  }

  const handleAccept = async () => {
    if (!currentSessionId || !currentFilePath || tier1Stale) return
    setBusy(true)
    try {
      await acceptFile(currentSessionId, messageId, currentFilePath)
    } finally {
      setBusy(false)
    }
  }

  const handleReject = async () => {
    if (!currentSessionId || !currentFilePath || tier1Stale) return
    setBusy(true)
    try {
      await rejectFile(currentSessionId, messageId, currentFilePath)
    } finally {
      setBusy(false)
    }
  }

  if (!diffCache) {
    return (
      <div className="inspector-empty">
        <p className="inspector-empty__hint">正在加载文件变更…</p>
      </div>
    )
  }

  if (diffs.length === 0 || !currentEntry || !currentFilePath) {
    return <ReviewEmpty />
  }

  const { dir, base } = splitPath(currentFilePath)
  const { additions, deletions } = countEntryChanges(currentEntry)
  const reviewedCount = diffs.filter(d => reviews[d.filePath]).length
  const canPrev = currentIndex > 0
  const canNext = currentIndex < diffs.length - 1
  const actionsDisabled = busy || tier1Stale || !currentSessionId

  return (
    <div className={`inspector-review${tier1Stale ? ' inspector-review--stale' : ''}`}>
      <div className="inspector-review__nav">
        <button
          type="button"
          className="inspector-icon-btn"
          aria-label="上一个文件"
          disabled={!canPrev}
          onClick={() => goFile(-1)}
        >
          <ChevronIcon size={14} direction="up" />
        </button>
        <button
          type="button"
          className="inspector-icon-btn"
          aria-label="下一个文件"
          disabled={!canNext}
          onClick={() => goFile(1)}
        >
          <ChevronIcon size={14} direction="down" />
        </button>
        <div className="inspector-review__path" title={currentFilePath}>
          {dir ? <span className="inspector-review__dir">{dir}</span> : null}
          <span className="inspector-review__base">{base}</span>
        </div>
        <span className={statusClass(currentEntry.status)}>
          <span className="diff-file__status-badge">{statusLabel(currentEntry.status)}</span>
        </span>
        <span className="diff-file__changes">
          <span className="diff-file__changes-add">+{additions}</span>
          <span className="diff-file__changes-del">-{deletions}</span>
        </span>
        {reviewStatus === 'accepted' && (
          <span className="diff-file__review-badge diff-file__review-badge--accepted">已审查</span>
        )}
        {reviewStatus === 'rejected' && (
          <span className="diff-file__review-badge diff-file__review-badge--rejected">已拒绝</span>
        )}
      </div>

      <div className="inspector-review__toolbar">
        <span className="inspector-review__agent-label">Agent 编辑</span>
        <div className="inspector-review__toggles">
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

      <div className="inspector-review__body" ref={bodyScrollRef}>
        {currentEntry.hunks.map((hunk, idx) => (
          <HunkView
            key={idx}
            hunk={hunk}
            filePath={currentEntry.filePath}
            status={currentEntry.status}
            syntaxHighlight={syntaxMode === 'syntax'}
            wrap={wrap}
            scrollRef={bodyScrollRef}
          />
        ))}
      </div>

      <div className="inspector-review__footer">
        <div className="inspector-review__progress">
          <span>审查中：{reviewedCount} / {diffs.length}</span>
          <button
            type="button"
            className="inspector-icon-btn"
            aria-label="上一个文件"
            disabled={!canPrev}
            onClick={() => goFile(-1)}
          >
            <ChevronIcon size={14} direction="up" />
          </button>
          <button
            type="button"
            className="inspector-icon-btn"
            aria-label="下一个文件"
            disabled={!canNext}
            onClick={() => goFile(1)}
          >
            <ChevronIcon size={14} direction="down" />
          </button>
        </div>
        <div className="inspector-review__actions">
          {reviewStatus === 'accepted' ? (
            <span className="diff-file__review-badge diff-file__review-badge--accepted">已审查</span>
          ) : reviewStatus === 'rejected' ? (
            <span className="diff-file__review-badge diff-file__review-badge--rejected">已拒绝</span>
          ) : (
            <>
              <Button
                label="回退"
                variant="secondary"
                size="sm"
                className="inspector-review__btn"
                isDisabled={actionsDisabled}
                onClick={() => void handleReject()}
                icon={<UndoIcon size={13} />}
              >
                回退
              </Button>
              <Button
                label="保留"
                variant="primary"
                size="sm"
                className="inspector-review__btn"
                isDisabled={actionsDisabled}
                onClick={() => void handleAccept()}
                icon={<CheckIcon size={13} />}
              >
                保留
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
})

export const ReviewTab: React.FC = () => {
  const reviewTarget = useLayoutStore(s => s.reviewTarget)
  const messages = useChatStore(s => s.messages)
  const messageDiffs = useChatStore(s => s.messageDiffs)

  const derivedMessageId = useMemo(
    () => (reviewTarget ? null : findDerivedMessageId(messages, messageDiffs)),
    [reviewTarget, messages, messageDiffs]
  )

  const messageId = reviewTarget?.messageId ?? derivedMessageId
  if (!messageId) return <ReviewEmpty />

  return (
    <ReviewContent
      messageId={messageId}
      preferredFilePath={reviewTarget?.filePath}
      localFileMode={!reviewTarget}
    />
  )
}
