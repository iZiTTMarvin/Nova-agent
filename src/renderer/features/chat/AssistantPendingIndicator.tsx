import React from 'react'

/** Assistant 空白等待态：模型已接管但还没产出文字、思考或工具调用时展示 */
export const AssistantPendingIndicator: React.FC = () => (
<div className="assistant-pending" role="status" aria-live="polite" aria-label="Nova 正在准备回复">
  <span className="assistant-pending__dots" aria-hidden="true">
    <span />
    <span />
    <span />
  </span>
  <span className="assistant-pending__label">正在思考</span>
</div>
)
