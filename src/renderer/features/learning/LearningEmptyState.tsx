/**
 * 学习空状态：标题 + 输入区 + 三条起点建议。有大纲时第一条建议直接选主题，
 * 其余作为普通消息发送。输入区通过 children 插在标题与建议之间。
 */
import { Button } from '@astryxdesign/core/Button'
import {
  LEARNING_START_SUGGESTIONS,
  learningEmptyStateTitle,
  learningTopicSuggestion
} from './learningCopy'

interface LearningEmptyStateProps {
  workspaceRoot: string | null
  firstTopic: { readonly nodeId: string; readonly title: string } | null
  disabled: boolean
  onSelectTopic: (nodeId: string) => void
  onSendMessage: (text: string) => void
  children: React.ReactNode
}

export function LearningEmptyState({
  workspaceRoot,
  firstTopic,
  disabled,
  onSelectTopic,
  onSendMessage,
  children
}: LearningEmptyStateProps): React.ReactElement {
  const messageSuggestions = firstTopic ? LEARNING_START_SUGGESTIONS.slice(1) : LEARNING_START_SUGGESTIONS
  return (
    <div className="learning-empty w-full flex flex-col items-center">
      <h2 className="learning-empty__title">{learningEmptyStateTitle(workspaceRoot)}</h2>
      {children}
      <div className="learning-empty__suggestions">
        {firstTopic && (
          <Button
            label={learningTopicSuggestion(firstTopic.title)}
            variant="secondary"
            size="sm"
            isDisabled={disabled}
            onClick={() => onSelectTopic(firstTopic.nodeId)}
          />
        )}
        {messageSuggestions.map(text => (
          <Button
            key={text}
            label={text}
            variant="secondary"
            size="sm"
            isDisabled={disabled}
            onClick={() => onSendMessage(text)}
          />
        ))}
      </div>
    </div>
  )
}
