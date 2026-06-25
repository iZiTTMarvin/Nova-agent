import React, { useState, useEffect } from 'react'
import { AlertIcon, InfoIcon, TerminalIcon } from '../../components/Icons'
import { useAppStore } from '../../stores/useAppStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import type { PermissionDecision } from '../../../shared/session/types'
import { PERMISSION_GRANT_SESSION_SCOPE, PERMISSION_UPSERT } from '../../../shared/ipc/channels'
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
  const currentSessionId = useAppStore(state => state.currentSessionId)

  const [showDropdown, setShowDropdown] = useState(false)

  // 点击外部关闭下拉菜单
  useEffect(() => {
    if (!showDropdown) return
    const handler = () => setShowDropdown(false)
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [showDropdown])

  if (!pendingRequest) return null

  const isBatch = !!pendingRequest.commands && pendingRequest.commands.length > 0
  const allowLabel = isBatch ? '全部允许' : '允许执行'

  const prefixes = new Set<string>()
  if (pendingRequest.commands && pendingRequest.commands.length > 0) {
    for (const cmd of pendingRequest.commands) {
      const token = cmd.trim().split(/\s+/)[0]
      if (token) prefixes.add(token)
    }
  } else {
    const prefix = extractCommandPrefix(pendingRequest.toolName, pendingRequest.args)
    if (prefix) prefixes.add(prefix)
  }
  const prefixArray = Array.from(prefixes)
  const hasPrefix = prefixArray.length > 0
  const commandPrefixText = prefixArray.join(', ')

  /**
   * 创建持久化规则后给出本次决策。
   */
  const rememberAndRespond = async (
    scope: 'project' | 'global',
    behavior: PermissionDecision
  ) => {
    const currentProject = useWorkspaceStore.getState().currentProjectPath
    const commandPrefix = extractCommandPrefix(pendingRequest.toolName, pendingRequest.args)

    // 项目级规则需要当前有打开的项目
    if (scope === 'project' && !currentProject) {
      scope = 'global'
    }

    try {
      await window.api.invoke(PERMISSION_UPSERT, {
        toolName: pendingRequest.toolName,
        behavior,
        scope,
        ...(commandPrefix ? { commandPrefix } : {}),
        description: `${scope === 'project' ? '本项目' : '全局'} ${behavior === 'allow' ? '允许' : behavior === 'deny' ? '拒绝' : '询问'} ${pendingRequest.toolName}${commandPrefix ? ' ' + commandPrefix : ''}`
      })
    } catch (err) {
      console.error('[PermissionPrompt] 创建持久化规则失败:', err)
    }

    respondPermissionRequest(behavior)
    setShowDropdown(false)
  }

  /**
   * 本会话允许同前缀命令
   */
  const rememberSessionAndRespond = async () => {
    if (!currentSessionId) return
    try {
      for (const prefix of prefixArray) {
        await window.api.invoke(PERMISSION_GRANT_SESSION_SCOPE, {
          sessionId: currentSessionId,
          commandPrefix: prefix
        })
      }
    } catch (err) {
      console.error('[PermissionPrompt] 授权临时白名单失败:', err)
    }
    respondPermissionRequest('allow')
    setShowDropdown(false)
  }

  const toggleDropdown = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowDropdown(!showDropdown)
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
            <span>执行内容 {isBatch ? `(${pendingRequest.commands?.length} 条命令)` : ''}</span>
          </div>
          {pendingRequest.commands && pendingRequest.commands.length > 0 ? (
            <div className="permission-prompt__commands-list">
              {pendingRequest.commands.map((cmd, i) => (
                <pre key={i} className="permission-prompt__command">{cmd}</pre>
              ))}
            </div>
          ) : typeof pendingRequest.args.command === 'string' ? (
            <pre className="permission-prompt__command">{pendingRequest.args.command}</pre>
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
          
          <div className="permission-prompt__btn-group">
            <button
              type="button"
              className="permission-prompt__btn permission-prompt__btn--allow"
              onClick={() => respondPermissionRequest('allow')}
              disabled={isSubmitting}
            >
              {isSubmitting ? '提交中...' : allowLabel}
            </button>
            <button
              type="button"
              className="permission-prompt__btn-dropdown-toggle"
              onClick={toggleDropdown}
              disabled={isSubmitting}
              title="更多授权选项"
            >
              <span className="dropdown-arrow">▾</span>
            </button>
            {showDropdown && (
              <div className="permission-prompt__dropdown-menu">
                <button
                  type="button"
                  onClick={() => respondPermissionRequest('allow')}
                  title="仅本次允许执行当前命令"
                >
                  仅本次允许
                </button>
                {hasPrefix && (
                  <button
                    type="button"
                    onClick={rememberSessionAndRespond}
                    title={`本会话内执行以 ${commandPrefixText} 开头的命令均直接放行，无需确认`}
                  >
                    本会话允许 ({commandPrefixText})
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void rememberAndRespond('project', 'allow')}
                  title="创建项目级允许规则，本项目内该命令不再弹窗"
                >
                  本项目永久允许
                </button>
                <button
                  type="button"
                  onClick={() => void rememberAndRespond('global', 'allow')}
                  title="创建全局允许规则，所有项目内该命令不再弹窗"
                >
                  全局永久允许
                </button>
                <div className="permission-prompt__dropdown-divider" />
                <button
                  type="button"
                  className="danger-option"
                  onClick={() => void rememberAndRespond('global', 'deny')}
                  title="创建全局拒绝规则，该命令将被永久拦截"
                >
                  始终拒绝执行
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
