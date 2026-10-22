/**
 * 学习输入区：自由提问走 message 命令；当前题等待回答时整个输入区换成停靠问题面板，
 * 保证同屏只有一个可编辑输入框。Enter 语义与开发输入框一致，命令未被接纳不清空草稿。
 */
import { useEffect, useRef } from 'react'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { ChatComposerInput, type ChatComposerInputHandle } from '@astryxdesign/core/Chat'
import { IconButton } from '@astryxdesign/core/IconButton'
import { SendIcon, StopIcon } from '../../components/Icons'
import type { LearningSurfaceProjection } from '../../../shared/learning/surface'
import { useAgentStore } from '../../stores/useAgentStore'
import { ContextIndicator } from '../chat/ContextIndicator'
import { ModelSelector } from '../chat/ModelSelector'
import { ReasoningEffortControl } from '../chat/ReasoningEffortControl'
import { CodeIndexStatusChip } from '../chat/CodeIndexStatusChip'
import { ComposerContextBar } from '../composer-context/ComposerContextBar'
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
  const composerFocusVersion = useWorkspaceStore(state => state.composerFocusVersion)
  useEffect(() => {
    inputHandleRef.current?.focus()
  }, [sessionId, composerFocusVersion])

  const currentQuestion =
    projection?.questions.find(question => question.checkpointId === projection.currentCheckpointId) ?? null
  if (currentQuestion?.state === 'awaiting_answer') {
    return <LearningQuestionDock sessionId={sessionId} question={currentQuestion} />
  }

  const send = (): void => {
    const value = text
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    setDraft(sessionId, null, '')
    void sendCommand({ sessionId, action: { type: 'message', text: trimmed } }).then(receipt => {
      // 发送立即清空输入框；若服务端拒绝且期间未输入新内容，立即恢复原草稿
      if (receipt?.ok !== true && !useLearningStore.getState().drafts[sessionId]?.message) {
        setDraft(sessionId, null, value)
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
    <div className="chat-composer-stack w-full">
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
        <div className="chat-composer__footer">
          <div className="chat-composer__footer-start">
            <CodeIndexStatusChip />
          </div>
          <div className="chat-composer__footer-end">
            <ContextIndicator />
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
      <ComposerContextBar />
    </div>
  )
}
