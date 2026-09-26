import type { LearningSurfaceProjection } from '../../../shared/learning/surface'
import { useLearningStore } from './useLearningStore'
import { useAgentStore } from '../../stores/useAgentStore'

interface LearningComposerProps {
  sessionId: string
  projection: LearningSurfaceProjection | null
  /** 教练回合生成中：显示取消入口（§12.2 取消状态必须可辨认） */
  isGenerating: boolean
  disabled: boolean
}

/**
 * 学习输入区：自由提问走 message 命令；未选点时默认 CTA 是「帮我选一个起点」，
 * 不做三个并列选项，避免面对大半「待整理」的树时选择瘫痪。
 * 命令未接纳不清空草稿。
 */
export function LearningComposer({
  sessionId,
  projection,
  isGenerating,
  disabled
}: LearningComposerProps): React.ReactElement {
  const text = useLearningStore(state => state.drafts[sessionId]?.message ?? '')
  const setDraft = useLearningStore(state => state.setDraft)
  const sendCommand = useLearningStore(state => state.sendCommand)
  const commandPending = useLearningStore(state => state.commandPending)
  const commandError = useLearningStore(state => state.commandError)
  const cancelExecution = useAgentStore(state => state.cancelExecution)
  const hasSelection = Boolean(projection?.selectedNodeId)
  const hasStarted = (projection?.cursorVersion ?? 0) > 0
  const needsAssessment = projection?.checkpoint?.state === 'answer_pending'

  const busy = disabled || commandPending

  const send = (value: string): void => {
    const trimmed = value.trim()
    if (!trimmed || busy) return
    // 命令未接纳不清空草稿（§12.4）：只有服务端确认接纳才清
    void sendCommand({ sessionId, action: { type: 'message', text: trimmed } }).then(receipt => {
      if (receipt?.ok === true && useLearningStore.getState().drafts[sessionId]?.message === value) {
        setDraft(sessionId, null, '')
      }
    })
  }

  const resumeAssessment = (): void => {
    if (busy) return
    void sendCommand({ sessionId, action: { type: 'resume' } })
  }

  return (
    <div className="learning-composer">
      {commandError && (
        <div className="learning-composer__error" role="alert">
          {commandError}
        </div>
      )}
      {!hasStarted && !needsAssessment && (
        <button
          type="button"
          className="learning-composer__cta"
          disabled={busy}
          onClick={() => send('帮我选一个起点')}
        >
          帮我选一个起点
        </button>
      )}
      {needsAssessment && (
        <button
          type="button"
          className="learning-composer__cta"
          disabled={busy}
          onClick={resumeAssessment}
        >
          继续评估上次回答
        </button>
      )}
      <div className="learning-composer__box">
        <textarea
          className="learning-composer__input"
          aria-label="学习提问输入"
          placeholder={hasSelection ? '继续问，或者换个想搞懂的问题' : '先问一个你想搞懂的问题'}
          value={text}
          rows={2}
          disabled={busy}
          onChange={event => setDraft(sessionId, null, event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send(text)
            }
          }}
        />
        {isGenerating ? (
          <button
            type="button"
            className="learning-composer__cancel"
            aria-label="取消本轮教练生成"
            onClick={() => void cancelExecution()}
          >
            取消生成
          </button>
        ) : (
          <button
            type="button"
            className="learning-composer__send"
            aria-label="发送学习问题"
            disabled={busy || !text.trim()}
            onClick={() => send(text)}
          >
            发送
          </button>
        )}
      </div>
      <p className="learning-composer__hint">
        {isGenerating
          ? '教练正在生成，可以随时取消；已保存的回答不会丢。'
          : '学习只读项目源码；需要改代码时，从材料面板回到开发会话。'}
      </p>
    </div>
  )
}
