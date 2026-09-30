/**
 * 学习输入区：自由提问走 message 命令；当前题等待回答时整个输入区换成停靠问题面板，
 * 保证同屏只有一个可编辑输入框。Enter 语义与开发输入框一致，命令未被接纳不清空草稿。
 */
import { useRef } from 'react'
import { ChatComposerInput, type ChatComposerInputHandle } from '@astryxdesign/core/Chat'
import { IconButton } from '@astryxdesign/core/IconButton'
import { SendIcon, StopIcon } from '../../components/Icons'
import type { LearningSurfaceProjection } from '../../../shared/learning/surface'
import { useAgentStore } from '../../stores/useAgentStore'
import { ModelSelector } from '../chat/ModelSelector'
import { ReasoningEffortControl } from '../chat/ReasoningEffortControl'
import { useLearningStore } from './useLearningStore'
import { LearningQuestionDock } from './LearningQuestionDock'
import {
  LEARNING_COMPOSER_LABEL,
  LEARNING_COMPOSER_PLACEHOLDER,
  LEARNING_COMPOSER_PLACEHOLDER_GENERATING,
  LEARNING_SEND_LABEL,
  LEARNING_STOP_LABEL
} from './learningCopy'

interface LearningComposerProps {
  sessionId: string
  projection: LearningSurfaceProjection | null
  /** 本会话 run 正在运行：显示停止入口并禁用输入 */
  isGenerating: boolean
  disabled: boolean
}

export function LearningComposer({
  sessionId,
  projection,
  isGenerating,
  disabled
}: LearningComposerProps): React.ReactElement {
  const text = useLearningStore(state => state.drafts[sessionId]?.message ?? '')
  const setDraft = useLearningStore(state => state.setDraft)
  const sendCommand = useLearningStore(state => state.sendCommand)
  const cancelExecution = useAgentStore(state => state.cancelExecution)
  const inputHandleRef = useRef<ChatComposerInputHandle>(null)

  const currentQuestion =
    projection?.questions.find(question => question.checkpointId === projection.currentCheckpointId) ?? null
  if (currentQuestion?.state === 'awaiting_answer') {
    return <LearningQuestionDock sessionId={sessionId} question={currentQuestion} />
  }

  const send = (): void => {
    const value = text
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    void sendCommand({ sessionId, action: { type: 'message', text: trimmed } }).then(receipt => {
      // 接纳才清空；期间用户又输入了新内容则不覆盖
      if (receipt?.ok === true && useLearningStore.getState().drafts[sessionId]?.message === value) {
        setDraft(sessionId, null, '')
      }
    })
  }

  /**
   * Enter 由产品层拥有：发送可被拒绝且必须保留草稿，因此不走 ChatComposerInput
   * 内置的 onSubmit（它会无条件清空编辑器）。
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.currentTarget.getAttribute('aria-expanded') === 'true') {
      event.preventDefault()
      return
    }
    event.preventDefault()
    send()
  }

  return (
    <div className="chat-composer-box w-full flex flex-col p-3">
      <ChatComposerInput
        className="chat-composer__input"
        handleRef={inputHandleRef}
        label={LEARNING_COMPOSER_LABEL}
        placeholder={isGenerating ? LEARNING_COMPOSER_PLACEHOLDER_GENERATING : LEARNING_COMPOSER_PLACEHOLDER}
        value={text}
        isDisabled={disabled}
        onChange={value => setDraft(sessionId, null, value)}
        onKeyDown={handleKeyDown}
        hasHistory={false}
        pasteAsToken={false}
        maxRows={14}
      />
      <div className="flex items-center justify-between mt-2 pt-1">
        <div aria-hidden="true" />
        <div className="flex items-center gap-2">
          <ModelSelector />
          <ReasoningEffortControl />
          {isGenerating ? (
            <IconButton
              label={LEARNING_STOP_LABEL}
              icon={<StopIcon size={14} />}
              variant="destructive"
              size="md"
              onClick={() => void cancelExecution()}
              tooltip={LEARNING_STOP_LABEL}
            />
          ) : (
            <IconButton
              label={LEARNING_SEND_LABEL}
              icon={<SendIcon size={14} />}
              variant="primary"
              size="md"
              onClick={send}
              isDisabled={disabled || !text.trim()}
              tooltip={LEARNING_SEND_LABEL}
            />
          )}
        </div>
      </div>
    </div>
  )
}
