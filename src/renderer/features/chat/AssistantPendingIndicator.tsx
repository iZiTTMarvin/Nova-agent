import React from 'react'
import { useComposeStore } from '../compose/useComposeStore'
import { useChatStore } from '../../stores/useChatStore'

/**
 * Assistant 空白等待态：模型已接管但还没产出文字、思考或工具调用时展示。
 * 编排运行中时改为显示阶段 + 最近日志（不写入消息正文，避免污染持久化）。
 */
export const AssistantPendingIndicator: React.FC = () => {
  const currentSessionId = useChatStore((s) => s.currentSessionId)
  const composeSessionId = useComposeStore((s) => s.sessionId)
  const composeState = useComposeStore((s) => s.state)
  const logs = useComposeStore((s) => s.logs)

  const isComposeRunning =
    !!currentSessionId &&
    composeSessionId === currentSessionId &&
    composeState?.run.status === 'running'

  const phaseLabel =
    composeState?.phase?.label || composeState?.phase?.current || ''
  const latestLog = logs.length > 0 ? logs[logs.length - 1] : ''

  const label = isComposeRunning
    ? `编排运行中${phaseLabel ? ` · ${phaseLabel}` : ''}`
    : '正在思考'

  const ariaLabel = isComposeRunning
    ? `编排运行中${phaseLabel ? `，${phaseLabel}` : ''}`
    : 'Nova 正在准备回复'

  return (
    <div
      className="assistant-pending"
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
    >
      <span className="assistant-pending__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="assistant-pending__text">
        <span className="assistant-pending__label">{label}</span>
        {isComposeRunning && latestLog ? (
          <span className="assistant-pending__log" title={latestLog}>
            {latestLog}
          </span>
        ) : null}
      </span>
    </div>
  )
}
