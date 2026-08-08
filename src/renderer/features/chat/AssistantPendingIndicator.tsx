import React from 'react'

/** 模型接管但尚未产出消息块时的轻量等待态。 */
export const AssistantPendingIndicator: React.FC = () => {
  return (
    <div
      className="assistant-pending"
      role="status"
      aria-live="polite"
      aria-label="Nova 正在准备回复"
    >
      <span className="assistant-pending__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="assistant-pending__text">
        <span className="assistant-pending__label">正在思考</span>
      </span>
    </div>
  )
}
