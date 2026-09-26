import type { LearningCheckpointView } from '../../../shared/learning/surface'
import { useLearningStore } from './useLearningStore'
import { checkpointStateLabel } from './learningStatus'

interface LearningCheckpointCardProps {
  sessionId: string
  checkpoint: LearningCheckpointView
  disabled: boolean
}

/**
 * 核对点卡：完整问题 + 自由输入 + 三个平级操作（提示 / 直接讲解 / 跳过）。
 * 提示不显示为「求助失败」；三个操作视觉平级。
 */
export function LearningCheckpointCard({
  sessionId,
  checkpoint,
  disabled
}: LearningCheckpointCardProps): React.ReactElement | null {
  const answer = useLearningStore(state => state.drafts[sessionId]?.answers[checkpoint.checkpointId] ?? '')
  const setDraft = useLearningStore(state => state.setDraft)
  const sendCommand = useLearningStore(state => state.sendCommand)
  const commandPending = useLearningStore(state => state.commandPending)

  if (checkpoint.state !== 'awaiting_answer') {
    return (
      <div className="learning-checkpoint learning-checkpoint--settled" role="status">
        <span className="learning-checkpoint__state">{checkpointStateLabel(checkpoint.state)}</span>
        <span className="learning-checkpoint__settled-question">{checkpoint.question}</span>
      </div>
    )
  }

  const submit = (action: Parameters<typeof sendCommand>[0]['action']): void => {
    void sendCommand({ sessionId, action }).then(receipt => {
      if (receipt?.ok && action.type === 'answer') setDraft(sessionId, checkpoint.checkpointId, '')
    })
  }

  return (
    <section className="learning-checkpoint" aria-label="学习核对点">
      <header className="learning-checkpoint__header">
        <span className="learning-checkpoint__badge">核对点</span>
        <span className="learning-checkpoint__state">{checkpointStateLabel(checkpoint.state)}</span>
      </header>
      <p className="learning-checkpoint__question">{checkpoint.question}</p>
      <textarea
        className="learning-checkpoint__answer"
        aria-label="核对点回答"
        placeholder="直接说你的理解，不用管措辞"
        value={answer}
        rows={3}
        onChange={event => setDraft(sessionId, checkpoint.checkpointId, event.target.value)}
        disabled={disabled || commandPending}
      />
      <div className="learning-checkpoint__actions">
        <button
          type="button"
          className="learning-checkpoint__action learning-checkpoint__action--primary"
          disabled={disabled || commandPending || !answer.trim()}
          onClick={() => {
            const text = answer.trim()
            if (!text) return
            submit({ type: 'answer', checkpointId: checkpoint.checkpointId, text, optionIds: [] })
          }}
        >
          提交回答
        </button>
        <button
          type="button"
          className="learning-checkpoint__action"
          disabled={disabled || commandPending}
          onClick={() => submit({ type: 'hint', checkpointId: checkpoint.checkpointId })}
        >
          提示
        </button>
        <button
          type="button"
          className="learning-checkpoint__action"
          disabled={disabled || commandPending}
          onClick={() => submit({ type: 'explain', checkpointId: checkpoint.checkpointId })}
        >
          直接讲解
        </button>
        <button
          type="button"
          className="learning-checkpoint__action"
          disabled={disabled || commandPending}
          onClick={() => submit({ type: 'skip', checkpointId: checkpoint.checkpointId })}
        >
          跳过
        </button>
      </div>
    </section>
  )
}
