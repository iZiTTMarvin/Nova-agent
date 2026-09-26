import { useEffect, useRef } from 'react'
import type { LearningSurfaceProjection } from '../../../shared/learning/surface'
import { SendIcon, StopIcon } from '../../components/Icons'
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
 * 学习输入区：自由提问走 message 命令；未选点时默认灵感建议是「帮我选一个起点」，
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const hasSelection = Boolean(projection?.selectedNodeId)
  const hasStarted = (projection?.cursorVersion ?? 0) > 0
  const needsAssessment = projection?.checkpoint?.state === 'answer_pending'
  const busy = disabled || commandPending

  // 输入框自适应高度伸缩（36px ~ 160px）
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const nextHeight = Math.min(Math.max(el.scrollHeight, 36), 160)
    el.style.height = `${nextHeight}px`
  }, [text])

  const send = (value: string): void => {
    const trimmed = value.trim()
    if (!trimmed || busy) return
    void sendCommand({ sessionId, action: { type: 'message', text: trimmed } }).then(receipt => {
      if (receipt?.ok === true && useLearningStore.getState().drafts[sessionId]?.message === value) {
        setDraft(sessionId, null, '')
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
        }
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
      {(!hasStarted || needsAssessment) && (
        <div className="learning-composer__quick-actions">
          {!hasStarted && !needsAssessment && (
            <button
              type="button"
              className="learning-composer__cta learning-composer__chip"
              disabled={busy}
              onClick={() => send('帮我选一个起点')}
            >
              帮我选一个起点
            </button>
          )}
          {needsAssessment && (
            <button
              type="button"
              className="learning-composer__cta learning-composer__chip learning-composer__chip--accent"
              disabled={busy}
              onClick={resumeAssessment}
            >
              继续评估上次回答
            </button>
          )}
        </div>
      )}
      <div className="learning-composer__box">
        <textarea
          ref={textareaRef}
          className="learning-composer__input"
          aria-label="学习提问输入"
          placeholder={hasSelection ? '继续问，或者换个想搞懂的问题…' : '先问一个你想搞懂的问题…'}
          value={text}
          disabled={disabled}
          readOnly={commandPending}
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
            <StopIcon size={14} />取消
          </button>
        ) : (
          <button
            type="button"
            className="learning-composer__send"
            aria-label="发送学习问题"
            disabled={busy || !text.trim()}
            onClick={() => send(text)}
          >
            <SendIcon size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
