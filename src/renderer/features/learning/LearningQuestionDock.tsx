/**
 * 停靠问题面板：出题时替换整个输入区，保证同屏只有一个可编辑输入框。
 * 外壳与输入框复用开发模式同一套组件；回答草稿按会话 + 题目保存，命令未被接纳不清空。
 * 回合运行中回答类操作禁用，但停止入口保留——输入区被本面板替换后这是唯一的中断位置。
 */
import { ChatComposerInput } from '@astryxdesign/core/Chat'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { BookIcon, StopIcon } from '../../components/Icons'
import type { LearningAction } from '../../../shared/learning/command'
import type { LearningQuestionView } from '../../../shared/learning/surface'
import { useAgentStore } from '../../stores/useAgentStore'
import { selectSessionIsRunning, useRunStore } from '../../stores/useRunStore'
import { useLearningStore } from './useLearningStore'
import {
  LEARNING_ANSWER_LABEL,
  LEARNING_ANSWER_PLACEHOLDER,
  LEARNING_DOCK_EYEBROW,
  LEARNING_DOCK_EXPLAIN,
  LEARNING_DOCK_HINT,
  LEARNING_DOCK_LABEL,
  LEARNING_DOCK_SKIP,
  LEARNING_DOCK_SUBMIT,
  LEARNING_STOP_LABEL
} from './learningCopy'

interface LearningQuestionDockProps {
  sessionId: string
  question: LearningQuestionView
}

export function LearningQuestionDock({ sessionId, question }: LearningQuestionDockProps): React.ReactElement {
  const answer = useLearningStore(state => state.drafts[sessionId]?.answers[question.checkpointId] ?? '')
  const setDraft = useLearningStore(state => state.setDraft)
  const sendCommand = useLearningStore(state => state.sendCommand)
  const commandPending = useLearningStore(state => state.sessionId === sessionId && state.commandPending)
  const isRunning = useRunStore(state => selectSessionIsRunning(state, sessionId))
  const cancelExecution = useAgentStore(state => state.cancelExecution)
  const disabled = isRunning || commandPending
  const checkpointId = question.checkpointId

  const submit = (action: LearningAction): void => {
    if (disabled) return
    void sendCommand({ sessionId, action }).then(receipt => {
      if (receipt?.ok && action.type === 'answer') setDraft(sessionId, checkpointId, '')
    })
  }

  const submitAnswer = (): void => {
    const text = answer.trim()
    if (!text) return
    submit({ type: 'answer', checkpointId, text, optionIds: [] })
  }

  // 与开发输入框同一套 Enter 语义：合成期间不提交，Shift/Alt+Enter 换行
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    event.preventDefault()
    submitAnswer()
  }

  return (
    <section
      className="chat-composer-box learning-dock w-full flex flex-col p-3"
      aria-label={LEARNING_DOCK_LABEL}
    >
      <div className="learning-dock__eyebrow">
        <BookIcon size={13} className="learning-dock__eyebrow-icon" aria-hidden="true" />
        <span>{LEARNING_DOCK_EYEBROW}</span>
      </div>
      <p className="learning-dock__question">{question.question}</p>
      <ChatComposerInput
        className="chat-composer__input"
        label={LEARNING_ANSWER_LABEL}
        placeholder={LEARNING_ANSWER_PLACEHOLDER}
        value={answer}
        isDisabled={disabled}
        onChange={value => setDraft(sessionId, checkpointId, value)}
        onKeyDown={handleKeyDown}
        hasHistory={false}
        pasteAsToken={false}
        maxRows={8}
      />
      <div className="learning-dock__actions">
        <div className="learning-dock__actions-secondary">
          <Button
            label={LEARNING_DOCK_HINT}
            variant="ghost"
            size="sm"
            isDisabled={disabled}
            onClick={() => submit({ type: 'hint', checkpointId })}
          />
          <Button
            label={LEARNING_DOCK_EXPLAIN}
            variant="ghost"
            size="sm"
            isDisabled={disabled}
            onClick={() => submit({ type: 'explain', checkpointId })}
          />
          <Button
            label={LEARNING_DOCK_SKIP}
            variant="ghost"
            size="sm"
            isDisabled={disabled}
            onClick={() => submit({ type: 'skip', checkpointId })}
          />
        </div>
        {isRunning ? (
          <IconButton
            label={LEARNING_STOP_LABEL}
            icon={<StopIcon size={14} />}
            variant="destructive"
            size="md"
            className="learning-dock__submit"
            onClick={() => void cancelExecution()}
            tooltip={LEARNING_STOP_LABEL}
          />
        ) : (
          <Button
            label={LEARNING_DOCK_SUBMIT}
            variant="primary"
            size="md"
            className="learning-dock__submit"
            isDisabled={disabled || !answer.trim()}
            onClick={submitAnswer}
          />
        )}
      </div>
    </section>
  )
}
