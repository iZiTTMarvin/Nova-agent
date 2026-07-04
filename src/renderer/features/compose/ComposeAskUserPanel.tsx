/**
 * 编排 askUser 面板（Dock）：阶段 5 发布确认 / 可选失败停顿
 * pendingAskUser 为 null 时不渲染。
 */
import React, { useState } from 'react'
import { useComposeStore } from './useComposeStore'
import './ComposeAskUserPanel.css'

export const ComposeAskUserPanel: React.FC = () => {
  const pending = useComposeStore((s) => s.pendingAskUser)
  const respondAskUser = useComposeStore((s) => s.respondAskUser)
  const isSubmitting = useComposeStore((s) => s.isSubmittingAskUser)
  const [selected, setSelected] = useState<string | null>(null)

  if (!pending) return null

  const handleSubmit = async (): Promise<void> => {
    if (!selected || isSubmitting) return
    await respondAskUser(selected)
    setSelected(null)
  }

  return (
    <div className="compose-ask-panel" role="dialog" aria-labelledby="compose-ask-title">
      <div className="compose-ask-panel__header">
        <span id="compose-ask-title" className="compose-ask-panel__title">
          编排需要你确认
        </span>
      </div>
      <p className="compose-ask-panel__question">{pending.question}</p>
      <div className="compose-ask-panel__options" role="radiogroup">
        {pending.options.map((opt) => (
          <label
            key={opt}
            className={`compose-ask-panel__option${selected === opt ? ' selected' : ''}`}
          >
            <input
              type="radio"
              name="compose-ask-user"
              value={opt}
              checked={selected === opt}
              onChange={() => setSelected(opt)}
              disabled={isSubmitting}
            />
            <span>{opt}</span>
          </label>
        ))}
      </div>
      <div className="compose-ask-panel__footer">
        <button
          type="button"
          className="compose-ask-panel__submit"
          disabled={!selected || isSubmitting}
          onClick={() => void handleSubmit()}
        >
          {isSubmitting ? '提交中…' : '确认'}
        </button>
      </div>
    </div>
  )
}
