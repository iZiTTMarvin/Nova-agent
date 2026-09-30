/**
 * 题目行：状态图标 + 问题文本，点击展开一行点评；「不认同」悬停出现，
 * 评估没完成时行内给出重试。状态图标与提示的映射在 learningCopy。
 */
import { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import {
  CheckIcon,
  CircleIcon,
  HelpCircleIcon,
  RefreshIcon,
  SkipIcon,
  SpinnerIcon
} from '../../components/Icons'
import type { LearningQuestionView } from '../../../shared/learning/surface'
import { selectSessionIsRunning, useRunStore } from '../../stores/useRunStore'
import { useLearningStore } from './useLearningStore'
import {
  LEARNING_DISPUTE_CANCEL,
  LEARNING_DISPUTE_LABEL,
  LEARNING_DISPUTE_PLACEHOLDER,
  LEARNING_DISPUTE_SEND,
  LEARNING_RETRY_LABEL,
  learningQuestionRowStatus,
  type LearningQuestionRowStatus
} from './learningCopy'

function RowStatusIcon({ status }: { status: LearningQuestionRowStatus }): React.ReactElement {
  const className = `learning-question__icon learning-question__icon--${status.tone}${status.spin ? ' learning-question__icon--spin' : ''}`
  switch (status.icon) {
    case 'check':
      return <CheckIcon size={13} className={className} />
    case 'refresh':
      return <RefreshIcon size={13} className={className} />
    case 'circle':
      return <CircleIcon size={13} className={className} />
    case 'help':
      return <HelpCircleIcon size={13} className={className} />
    case 'skip':
      return <SkipIcon size={13} className={className} />
    case 'spinner':
      return <SpinnerIcon size={13} className={className} />
  }
}

interface LearningQuestionRowProps {
  sessionId: string
  question: LearningQuestionView
}

export function LearningQuestionRow({ sessionId, question }: LearningQuestionRowProps): React.ReactElement | null {
  const isRunning = useRunStore(state => selectSessionIsRunning(state, sessionId))
  const commandPending = useLearningStore(state => state.sessionId === sessionId && state.commandPending)
  const sendCommand = useLearningStore(state => state.sendCommand)
  const setDraft = useLearningStore(state => state.setDraft)
  const answers = useLearningStore(state => state.drafts[sessionId]?.answers)
  const [expanded, setExpanded] = useState(false)
  const [disputing, setDisputing] = useState(false)

  const status = learningQuestionRowStatus(question, isRunning)
  if (!status) return null

  const assessment = question.assessment
  const disputeKey = assessment ? `dispute:${assessment.assessmentId}` : null
  const reason = disputeKey ? answers?.[disputeKey] ?? '' : ''
  const busy = isRunning || commandPending
  const canDispute = assessment !== null && !assessment.disputed
  const needsResume = question.state === 'answer_pending' && !isRunning

  const submitDispute = (): void => {
    if (!assessment) return
    void sendCommand({
      sessionId,
      action: { type: 'dispute', assessmentId: assessment.assessmentId, reason: reason.trim() }
    }).then(receipt => {
      if (receipt?.ok) {
        setDisputing(false)
        if (disputeKey) setDraft(sessionId, disputeKey, '')
      }
    })
  }

  return (
    <div className="learning-question">
      <div className="learning-question__line">
        <Button
          label={question.question}
          variant="ghost"
          size="sm"
          className="learning-question__main"
          aria-expanded={assessment?.summary ? expanded : undefined}
          onClick={() => {
            if (assessment?.summary) setExpanded(previous => !previous)
          }}
        >
          <span className="learning-question__content">
            <span
              className="learning-question__status"
              role="img"
              aria-label={status.label ?? undefined}
              title={status.label ?? undefined}
            >
              <RowStatusIcon status={status} />
            </span>
            <span className="learning-question__text">{question.question}</span>
          </span>
        </Button>
        {needsResume && (
          <span className="learning-question__pending">
            {status.label}
            <Button
              label={LEARNING_RETRY_LABEL}
              variant="ghost"
              size="sm"
              isDisabled={busy}
              onClick={() => void sendCommand({ sessionId, action: { type: 'resume' } })}
            />
          </span>
        )}
        {canDispute && (
          <Button
            label={LEARNING_DISPUTE_LABEL}
            variant="ghost"
            size="sm"
            className="learning-question__dispute"
            isDisabled={busy}
            onClick={() => {
              setExpanded(true)
              setDisputing(true)
            }}
          />
        )}
      </div>
      {expanded && assessment?.summary && (
        <p className="learning-question__review">{assessment.summary}</p>
      )}
      {disputing && assessment && (
        <div className="learning-question__dispute-form">
          <TextInput
            label={LEARNING_DISPUTE_LABEL}
            isLabelHidden
            className="learning-question__dispute-input"
            value={reason}
            placeholder={LEARNING_DISPUTE_PLACEHOLDER}
            isDisabled={busy}
            onChange={value => {
              if (disputeKey) setDraft(sessionId, disputeKey, value)
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submitDispute()
              }
              if (event.key === 'Escape') setDisputing(false)
            }}
          />
          <Button
            label={LEARNING_DISPUTE_SEND}
            variant="secondary"
            size="sm"
            isDisabled={busy}
            onClick={submitDispute}
          />
          <Button
            label={LEARNING_DISPUTE_CANCEL}
            variant="ghost"
            size="sm"
            isDisabled={busy}
            onClick={() => setDisputing(false)}
          />
        </div>
      )}
    </div>
  )
}
