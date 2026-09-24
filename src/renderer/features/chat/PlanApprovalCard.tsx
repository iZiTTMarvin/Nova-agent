import React, { useMemo, useRef, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import type { PendingPlanReview, PlanReviewDecision } from '../../../shared/planReview'
import { CheckSmallIcon, ShieldCheckIcon } from '../../components/Icons'
import './PlanApprovalCard.css'

export interface PlanApprovalCardProps {
  review: PendingPlanReview
}

/** 消息流内的等待状态行：审批交互在底部 dock（替换输入区），此处只标记暂停点 */
export const PlanApprovalPendingRow: React.FC = React.memo(function PlanApprovalPendingRow() {
  return (
    <div className="plan-approval-pending" role="status">
      <span className="plan-approval-pending__glyph" aria-hidden="true">
        <ShieldCheckIcon size={13} />
      </span>
      <span className="plan-approval-pending__label">等待计划审批</span>
      <span className="plan-approval-pending__hint">在下方输入区处理</span>
    </div>
  )
})

/** 忽略后的终态记录：由 switch_mode / stage_transition 工具结果标记驱动，不可交互 */
export const PlanApprovalIgnoredCard: React.FC<{ source?: 'plan' | 'compose' }> =
  function PlanApprovalIgnoredCard({ source = 'plan' }) {
    const title = source === 'compose' ? '确认一页纸' : '实施计划'
    return (
      <section className="plan-approval-card plan-approval-card--ignored" aria-label="实施计划审批">
        <header className="plan-approval-card__header">
          <div>
            <span className="plan-approval-card__eyebrow">计划审批</span>
            <h3 className="plan-approval-card__title">{title}</h3>
          </div>
          <span className="plan-approval-card__resolved-badge">已忽略</span>
        </header>
      </section>
    )
  }

function commandId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `plan-review-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export const PlanApprovalCard: React.FC<PlanApprovalCardProps> = React.memo(function PlanApprovalCard({ review }) {
  const [decision, setDecision] = useState<Extract<PlanReviewDecision, 'approve' | 'revise'>>('approve')
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isRespondingRef = useRef(false)
  const stableCommandId = useMemo(() => commandId(), [review.interactionId])
  const isCompose = review.source === 'compose'
  const title = isCompose ? '确认一页纸' : '实施计划'
  const approveDescription = isCompose
    ? '进入「锤」'
    : '退出计划模式并开始实施'

  const respond = async (nextDecision: PlanReviewDecision) => {
    if (isRespondingRef.current || submitting) return
    const trimmed = feedback.trim()
    if (nextDecision === 'revise' && !trimmed) {
      setError('请先填写需要修改的内容')
      return
    }

    isRespondingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const result = await window.api.invoke('respond-plan-review', {
        interactionId: review.interactionId,
        commandId: stableCommandId,
        expectedVersion: review.commandVersion,
        decision: nextDecision,
        ...(nextDecision === 'revise' ? { feedback: trimmed } : {})
      })
      if (!result.ok) {
        setError(result.message)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSubmitting(false)
      isRespondingRef.current = false
    }
  }

  return (
    <section className="plan-approval-card" aria-label="实施计划审批">
      <header className="plan-approval-card__header">
        <span className="plan-approval-card__eyebrow">需要权限</span>
        <h3 className="plan-approval-card__title">{title}</h3>
        <span className="plan-approval-card__count" aria-label="第 1 项，共 1 项">1 / 1</span>
      </header>

      <div className="plan-approval-card__choices">
        <button
          type="button"
          className={`plan-approval-card__choice${decision === 'approve' ? ' plan-approval-card__choice--selected' : ''}`}
          onClick={() => setDecision('approve')}
          aria-pressed={decision === 'approve'}
        >
          <span className="plan-approval-card__radio" aria-hidden="true">
            {decision === 'approve' && <CheckSmallIcon size={12} />}
          </span>
          <span>
            <strong>批准</strong>
            <small>{approveDescription}</small>
          </span>
        </button>

        <div className={`plan-approval-card__feedback${decision === 'revise' ? ' plan-approval-card__feedback--selected' : ''}`}>
          <textarea
            value={feedback}
            placeholder="输入你的回答…（填写后提交即为修改计划）"
            rows={2}
            aria-label="修改计划反馈"
            onFocus={() => setDecision('revise')}
            onChange={event => {
              setFeedback(event.target.value)
              setDecision('revise')
            }}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void respond('revise')
              }
            }}
            disabled={submitting}
          />
        </div>
      </div>

      {error && <div className="plan-approval-card__error" role="alert">{error}</div>}

      <footer className="plan-approval-card__footer">
        <span className="plan-approval-card__hint">Ctrl ↵ 提交修改</span>
        <Button
          label="忽略"
          variant="ghost"
          size="sm"
          onClick={() => void respond('ignore')}
          isDisabled={submitting}
        />
        <Button
          label={submitting ? '提交中…' : decision === 'revise' ? '提交修改' : '批准'}
          variant="primary"
          size="sm"
          onClick={() => void respond(decision)}
          isDisabled={submitting || (decision === 'revise' && !feedback.trim())}
        />
      </footer>
    </section>
  )
})
