/**
 * 最后一条回复下方的追问建议：只显示模型针对本轮内容写的推荐，没有推荐就不渲染，
 * 不用固定文案顶替。点击即把该句作为普通学习消息发出。
 */
import { Button } from '@astryxdesign/core/Button'
import { CornerDownRightIcon } from '../../components/Icons'
import { LEARNING_SUGGESTIONS_LABEL } from './learningCopy'

interface LearningSuggestionsProps {
  suggestions: readonly string[]
  disabled: boolean
  onSend: (text: string) => void
}

export function LearningSuggestions({ suggestions, disabled, onSend }: LearningSuggestionsProps): React.ReactElement | null {
  if (suggestions.length === 0) return null
  return (
    <div className="learning-suggestions" role="group" aria-label={LEARNING_SUGGESTIONS_LABEL}>
      {suggestions.map(text => (
        <Button
          key={text}
          label={text}
          variant="ghost"
          size="sm"
          className="learning-suggestions__item"
          isDisabled={disabled}
          onClick={() => onSend(text)}
        >
          <span className="learning-suggestions__content">
            <CornerDownRightIcon size={14} className="learning-suggestions__icon" aria-hidden="true" />
            <span className="learning-suggestions__text">{text}</span>
          </span>
        </Button>
      ))}
    </div>
  )
}
