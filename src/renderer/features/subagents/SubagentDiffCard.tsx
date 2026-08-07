/**
 * SubagentDiffCard — 子代理完成后的会话级 diff 卡
 *
 * 展示 N 个文件改动清单（前 5 条，超出折叠），Review 展开内联 DiffViewer。
 * 数据经 get-session-diffs 会话级聚合；逐文件 accept/reject 用 messageIdByFile
 * 路由到既有消息级 IPC，组件自管状态，不依赖绑定当前会话的 chat diffSlice。
 */
import React, { useCallback, useState } from 'react'
import type { SessionMessageDiffsState } from '../../../shared/diff/types'
import type { SubagentActivityProjection, SubagentFileChange } from '../../../shared/subagents'
import { DiffViewer } from '../diff/DiffViewer'
import './SubagentActivityRow.css'

/** 默认展示的文件行数，超出折叠到 Show N more */
const PREVIEW_FILE_COUNT = 5

const STATUS_LABEL: Record<SubagentFileChange['status'], string> = {
  added: '新建',
  modified: '修改',
  deleted: '删除'
}

export const SubagentDiffCard: React.FC<{ projection: SubagentActivityProjection }> = ({
  projection
}) => {
  const changes = projection.fileChanges ?? []
  const [showAll, setShowAll] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [diffState, setDiffState] = useState<SessionMessageDiffsState | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const state = await window.api.invoke('get-session-diffs', {
        sessionId: projection.childSessionId
      })
      setDiffState(state)
    } catch {
      setDiffState(null)
    }
  }, [projection.childSessionId])

  const toggleReview = (): void => {
    if (reviewing) {
      setReviewing(false)
      return
    }
    setReviewing(true)
    setLoadingDiff(true)
    void refresh().finally(() => setLoadingDiff(false))
  }

  const applyReview = async (
    filePath: string,
    channel: 'accept-file' | 'reject-file'
  ): Promise<void> => {
    const messageId = diffState?.messageIdByFile[filePath]
    if (!messageId) return
    await window.api.invoke(channel, {
      sessionId: projection.childSessionId,
      messageId,
      filePath
    })
    // 审查状态落盘后重拉，保证徽章与路由表一致
    await refresh()
  }

  if (changes.length === 0) return null

  const visibleChanges = showAll ? changes : changes.slice(0, PREVIEW_FILE_COUNT)
  return (
    <aside className="subagent-diff-card">
      <div className="subagent-diff-card__header">
        <span className="subagent-diff-card__title">{changes.length} 个文件改动</span>
        {!reviewing ? (
          <button
            type="button"
            className="subagent-diff-card__review-btn"
            onClick={toggleReview}
          >
            Review
          </button>
        ) : (
          <button
            type="button"
            className="subagent-diff-card__review-btn"
            onClick={() => setReviewing(false)}
          >
            收起
          </button>
        )}
      </div>

      <ul className="subagent-diff-card__files">
        {visibleChanges.map((change) => (
          <li key={change.filePath} className="subagent-diff-card__file">
            <span
              className={`subagent-diff-card__badge subagent-diff-card__badge--${change.status}`}
            >
              {STATUS_LABEL[change.status]}
            </span>
            <span className="subagent-diff-card__path" title={change.filePath}>
              {change.filePath}
            </span>
            <span className="subagent-diff-card__stats">
              <span className="subagent-diff-card__add">+{change.addedLines}</span>
              <span className="subagent-diff-card__del">-{change.removedLines}</span>
            </span>
          </li>
        ))}
      </ul>

      {!showAll && changes.length > PREVIEW_FILE_COUNT && (
        <button
          type="button"
          className="subagent-diff-card__more"
          onClick={() => setShowAll(true)}
        >
          Show {changes.length - PREVIEW_FILE_COUNT} more
        </button>
      )}

      {reviewing &&
        (diffState ? (
          <div className="subagent-diff-card__viewer">
            <DiffViewer
              diffs={diffState.diffs}
              reviews={diffState.reviews}
              sessionId={projection.childSessionId}
              skippedFiles={diffState.skippedFiles}
              isLoading={loadingDiff}
              onAcceptFile={(filePath) => applyReview(filePath, 'accept-file')}
              onRejectFile={(filePath) => applyReview(filePath, 'reject-file')}
            />
          </div>
        ) : (
          <div className="subagent-diff-card__error">差异加载失败</div>
        ))}
    </aside>
  )
}
