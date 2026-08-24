import React, { useMemo, useRef, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import type { PendingPlanReview, PlanReviewDecision } from '../../../shared/planReview'
import { CheckSmallIcon } from '../../components/Icons'
import './PlanApprovalCard.css'

export interface PlanApprovalCardProps {
  review: PendingPlanReview
}

/** 忽略后的终态记录：由 switch_mode / stage_transition 工具结果标记驱动，不可交互 */
export const PlanApprovalIgnoredCard: React.FC = function PlanApprovalIgnoredCard() {
  return (
    <section className="plan-approval-card plan-approval-card--ignored" aria-label="实施计划审批">
      <header className="plan-approval-card__header">
        <div>
          <span className="plan-approval-card__eyebrow">计划审批</span>
          <h3 className="plan-approval-card__title">实施计划</h3>
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
  const approveDescription = review.source === 'compose'
    ? '进入开发阶段'
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
        <div>
          <span className="plan-approval-card__eyebrow">需要权限</span>
          <h3 className="plan-approval-card__title">实施计划</h3>
        </div>
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

        <label className={`plan-approval-card__feedback${decision === 'revise' ? ' plan-approval-card__feedback--selected' : ''}`}>
          <span>修改计划</span>
          <textarea
            value={feedback}
            placeholder="说明需要调整的内容…"
            rows={3}
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
        </label>
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
