import React, { useState } from 'react'
import { AlertIcon, InfoIcon, TerminalIcon } from '../../components/Icons'
import { useAppStore } from '../../stores/useAppStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import type { PermissionDecision } from '../../../shared/session/types'
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

/**
 * 从当前权限请求中提取用于规则匹配的命令前缀。
 * bash 命令取首个 token 作为前缀（如 "npm install" → "npm"），
 * 非命令工具返回 undefined（不创建 commandPrefix 匹配条件）。
 */
function extractCommandPrefix(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName !== 'bash') return undefined
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) return undefined
  // 取首个 token（命令本体，不含参数），避免规则过窄或过宽
  const firstToken = command.split(/\s+/)[0]
  return firstToken || undefined
}

export const PermissionPrompt: React.FC = () => {
  const pendingRequest = useAppStore(state => state.pendingPermissionRequest)
  const isSubmitting = useAppStore(state => state.isSubmittingPermission)
  const permissionError = useAppStore(state => state.permissionError)
  const respondPermissionRequest = useAppStore(state => state.respondPermissionRequest)
  /** 是否展开"记忆选项"区域 */
  const [showRemember, setShowRemember] = useState(false)

  if (!pendingRequest) return null

  const commandText =
    typeof pendingRequest.args.command === 'string'
      ? pendingRequest.args.command
      : null

  /**
   * 创建持久化规则后给出本次决策。
   * - scope=project：始终允许本项目（仅当当前有打开的项目）
   * - scope=global：始终允许全局
   * - behavior=deny：始终拒绝（本次也拒绝）
   */
  const rememberAndRespond = async (
    scope: 'project' | 'global',
    behavior: PermissionDecision
  ) => {
    const currentProject = useWorkspaceStore.getState().currentProjectPath
    const commandPrefix = extractCommandPrefix(pendingRequest.toolName, pendingRequest.args)

    // 项目级规则需要当前有打开的项目
    if (scope === 'project' && !currentProject) {
      // 无项目时降级为全局规则
      scope = 'global'
    }

    try {
      await window.api.invoke('permission:upsert', {
        toolName: pendingRequest.toolName,
        behavior,
        scope,
        ...(commandPrefix ? { commandPrefix } : {}),
        description: `${scope === 'project' ? '本项目' : '全局'} ${behavior === 'allow' ? '允许' : behavior === 'deny' ? '拒绝' : '询问'} ${pendingRequest.toolName}${commandPrefix ? ' ' + commandPrefix : ''}`
      })
    } catch (err) {
      // 规则创建失败不阻塞本次决策，仅记录
      console.error('[PermissionPrompt] 创建持久化规则失败:', err)
    }

    respondPermissionRequest(behavior)
    setShowRemember(false)
  }

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

        {/* 记忆选项：创建持久化规则 */}
        <div className="permission-prompt__remember">
          <button
            type="button"
            className="permission-prompt__remember-toggle"
            onClick={() => setShowRemember(!showRemember)}
            disabled={isSubmitting}
          >
            {showRemember ? '▾' : '▸'} 记住选择（创建持久化规则）
          </button>
          {showRemember && (
            <div className="permission-prompt__remember-actions">
              <button
                type="button"
                className="permission-prompt__btn permission-prompt__btn--remember-allow"
                onClick={() => void rememberAndRespond('project', 'allow')}
                disabled={isSubmitting}
                title="创建项目级允许规则，本项目内该命令不再弹窗"
              >
                始终允许（本项目）
              </button>
              <button
                type="button"
                className="permission-prompt__btn permission-prompt__btn--remember-allow"
                onClick={() => void rememberAndRespond('global', 'allow')}
                disabled={isSubmitting}
                title="创建全局允许规则，所有项目内该命令不再弹窗"
              >
                始终允许（全局）
              </button>
              <button
                type="button"
                className="permission-prompt__btn permission-prompt__btn--remember-deny"
                onClick={() => void rememberAndRespond('global', 'deny')}
                disabled={isSubmitting}
                title="创建全局拒绝规则，该命令将被永久拦截"
              >
                始终拒绝
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
