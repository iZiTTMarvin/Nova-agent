import React from 'react'
import { useChatStore } from '../../stores/useChatStore'
import { useWorkflowStore } from '../workflow/useWorkflowStore'
import { formatPhaseLabel } from './WorkflowProgressBlock'

/** 模型接管但尚未产出消息块时的轻量等待态。 */
export const AssistantPendingIndicator: React.FC = () => {
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const activeRun = useWorkflowStore((state) => state.activeRun)
  const workflowRunning =
    activeRun !== null &&
    (activeRun.sessionId === null || activeRun.sessionId === currentSessionId)
  const phase = workflowRunning ? formatPhaseLabel(activeRun.phase) : ''
  const label = workflowRunning ? `编排运行中${phase ? ` · ${phase}` : ''}` : '正在思考'

  return (
    <div
      className="assistant-pending"
      role="status"
      aria-live="polite"
      aria-label={workflowRunning ? label : 'Nova 正在准备回复'}
    >
      <span className="assistant-pending__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="assistant-pending__text">
        <span className="assistant-pending__label">{label}</span>
      </span>
    </div>
  )
}
