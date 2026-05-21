import React from 'react'
import { AlertIcon, InfoIcon, TerminalIcon } from '../../components/Icons'
import { useAppStore } from '../../stores/useAppStore'
import './PermissionPrompt.css'

function getRiskLabel(riskLevel: 'low' | 'medium' | 'high'): string {
  switch (riskLevel) {
    case 'high':
      return '高风险'
    case 'medium':
      return '中风险'
    default:
      return '低风险'
  }
}

export const PermissionPrompt: React.FC = () => {
  const pendingRequest = useAppStore(state => state.pendingPermissionRequest)
  const isSubmitting = useAppStore(state => state.isSubmittingPermission)
  const permissionError = useAppStore(state => state.permissionError)
  const respondPermissionRequest = useAppStore(state => state.respondPermissionRequest)

  if (!pendingRequest) return null

  const commandText =
    typeof pendingRequest.args.command === 'string'
      ? pendingRequest.args.command
      : null

  return (
    <div className="permission-prompt__overlay" role="presentation">
      <div
        className="permission-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="permission-prompt-title"
      >
        <div className="permission-prompt__header">
          <div className="permission-prompt__title-wrap">
            <AlertIcon
              size={18}
              className={`permission-prompt__risk-icon permission-prompt__risk-icon--${pendingRequest.riskLevel}`}
            />
            <div>
              <h2 id="permission-prompt-title" className="permission-prompt__title">
                需要确认工具执行权限
              </h2>
              <p className="permission-prompt__subtitle">
                Agent 正在请求执行 `{pendingRequest.toolName}` 工具。
              </p>
            </div>
          </div>

          <span
            className={`permission-prompt__risk-badge permission-prompt__risk-badge--${pendingRequest.riskLevel}`}
          >
            {getRiskLabel(pendingRequest.riskLevel)}
          </span>
        </div>

        <div className="permission-prompt__section">
          <div className="permission-prompt__section-title">
            <InfoIcon size={14} />
            <span>风险说明</span>
          </div>
          <p className="permission-prompt__reason">{pendingRequest.reason}</p>
        </div>

        <div className="permission-prompt__section">
          <div className="permission-prompt__section-title">
            <TerminalIcon size={14} />
            <span>执行内容</span>
          </div>
          {commandText ? (
            <pre className="permission-prompt__command">{commandText}</pre>
          ) : (
            <pre className="permission-prompt__command">
              {JSON.stringify(pendingRequest.args, null, 2)}
            </pre>
          )}
        </div>

        {permissionError && (
          <div className="permission-prompt__error">{permissionError}</div>
        )}

        <div className="permission-prompt__actions">
          <button
            type="button"
            className="permission-prompt__btn permission-prompt__btn--deny"
            onClick={() => respondPermissionRequest('deny')}
            disabled={isSubmitting}
          >
            拒绝执行
          </button>
          <button
            type="button"
            className="permission-prompt__btn permission-prompt__btn--allow"
            onClick={() => respondPermissionRequest('allow')}
            disabled={isSubmitting}
          >
            {isSubmitting ? '提交中...' : '允许执行'}
          </button>
        </div>
      </div>
    </div>
  )
}
