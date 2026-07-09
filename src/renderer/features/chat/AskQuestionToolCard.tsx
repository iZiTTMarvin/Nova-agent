/**
 * AskQuestionToolCard —— 消息流内 askQuestion 状态行
 *
 * 不承载答题交互（答题在底部 AskQuestionPanel）。
 * running：正在询问；success：已询问 N 个问题，可展开回看问答摘要。
 */
import React, { useState } from 'react'
import { ChevronIcon } from '../../components/Icons'

export interface AskQuestionToolCardProps {
  toolCallId?: string
  args: Record<string, unknown>
  status: 'running' | 'success' | 'error'
  result?: string
  isLiveStreaming?: boolean
}

export interface AskQuestionQAPair {
  question: string
  answer: string
}

/** 解析 formatAnswers 输出，供展开回看 */
export function parseAskQuestionResult(result: string | undefined): {
  dismissed: boolean
  pairs: AskQuestionQAPair[]
} {
  if (!result?.trim()) return { dismissed: false, pairs: [] }
  const trimmed = result.trim()
  if (trimmed === 'User dismissed the question.') {
    return { dismissed: true, pairs: [] }
  }

  const prefix = 'User has answered your questions: '
  if (!trimmed.startsWith(prefix)) return { dismissed: false, pairs: [] }

  let body = trimmed.slice(prefix.length)
  if (body.endsWith('.')) body = body.slice(0, -1)

  const pairs: AskQuestionQAPair[] = []
  // "问题"="答案" 或 "问题"=[dismissed]；可带 , custom="…"；多题以 "; " 分隔
  const parts = body.split('; ')
  for (const part of parts) {
    const dismissed = part.match(/^"((?:\\.|[^"\\])*)"=\[dismissed\]/)
    if (dismissed) {
      pairs.push({ question: dismissed[1].replace(/\\"/g, '"'), answer: '[已跳过]' })
      continue
    }
    const m = part.match(/^"((?:\\.|[^"\\])*)"="((?:\\.|[^"\\])*)"(?:, custom="((?:\\.|[^"\\])*)")?/)
    if (!m) continue
    const question = m[1].replace(/\\"/g, '"')
    let answer = m[2].replace(/\\"/g, '"')
    if (m[3]) answer = `${answer}（自定义：${m[3].replace(/\\"/g, '"')}）`
    pairs.push({ question, answer })
  }
  return { dismissed: false, pairs }
}

function questionCount(args: Record<string, unknown>): number {
  const questions = Array.isArray(args.questions) ? args.questions : []
  return questions.length
}

export const AskQuestionToolCard: React.FC<AskQuestionToolCardProps> = React.memo(
  function AskQuestionToolCard({ args, status, result, isLiveStreaming = false }) {
    const [expanded, setExpanded] = useState(false)
    const count = questionCount(args)
    const parsed = parseAskQuestionResult(result)
    const canExpand = status === 'success' && (parsed.pairs.length > 0 || parsed.dismissed)

    let label = '正在询问'
    if (status === 'success') {
      if (parsed.dismissed) label = '已跳过提问'
      else label = count > 0 ? `已询问 ${count} 个问题` : '已询问'
    } else if (status === 'error') {
      label = '提问失败'
    }

    const rootClass = [
      'ask-question-tool-card',
      isLiveStreaming ? 'ask-question-tool-card--live-enter' : '',
      expanded ? 'ask-question-tool-card--expanded' : ''
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <div className={rootClass}>
        <button
          type="button"
          className="ask-question-tool-card__header"
          onClick={() => {
            if (canExpand) setExpanded(prev => !prev)
          }}
          aria-expanded={canExpand ? expanded : undefined}
          disabled={!canExpand}
        >
          <span className={`ask-question-tool-card__glyph ask-question-tool-card__glyph--${status}`} aria-hidden="true">
            ?
          </span>
          <span className="ask-question-tool-card__label">{label}</span>
          {canExpand && (
            <span className="ask-question-tool-card__chevron" data-expanded={expanded} aria-hidden="true">
              <ChevronIcon size={14} direction={expanded ? 'up' : 'down'} />
            </span>
          )}
        </button>

        {expanded && parsed.pairs.length > 0 && (
          <div className="ask-question-tool-card__detail">
            {parsed.pairs.map((pair, i) => (
              <div key={i} className="ask-question-tool-card__qa">
                <div className="ask-question-tool-card__q">{pair.question}</div>
                <div className="ask-question-tool-card__a">{pair.answer}</div>
              </div>
            ))}
          </div>
        )}
        {expanded && parsed.dismissed && (
          <div className="ask-question-tool-card__detail">
            <div className="ask-question-tool-card__a">用户跳过了提问</div>
          </div>
        )}
      </div>
    )
  }
)
