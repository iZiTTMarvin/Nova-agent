import React, { useState, useEffect, useRef } from 'react'
import { useAgentStore } from '../../stores/useAgentStore'
import { useChatStore } from '../../stores/useChatStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import type { PermissionDecision } from '../../../shared/session/types'
import type { PendingPermissionRequest } from '../../stores/types'
import { PERMISSION_GRANT_SESSION_SCOPE, PERMISSION_UPSERT } from '../../../shared/ipc/channels'
import './InlinePermissionBar.css'

/**
 * InlinePermissionBar — 内联放行条
 *
 * 取代原先 composer 上方的全屏式权限卡片：直接渲染在消息流中对应命令卡片
 * （ToolBox）的底部，跟随消息一起滚动，对标 Windsurf「按钮长在命令卡片上」的形态。
 *
 * 职责：
 * - 展示风险说明（命令文本由所在卡片头部已呈现，这里不重复）
 * - 主操作：允许 / 拒绝；批量时主按钮为「全部允许（N 条）」
 * - 下拉粒度：仅本次 / 本会话 / 本项目永久 / 全局永久 / 始终拒绝
 *
 * 命令文本由卡片负责展示，本组件只承载「决策」。所有授权粒度逻辑与原
 * PermissionPrompt 一致，仅形态从模态卡片改为内联条。
 */

/**
 * 从权限请求中提取用于规则匹配的命令前缀。
 * bash 取首个 token（如 "npm install" → "npm"），非命令工具返回 undefined。
 */
function extractCommandPrefix(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName !== 'bash') return undefined
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) return undefined
  const firstToken = command.split(/\s+/)[0]
  return firstToken || undefined
}

export interface InlinePermissionBarProps {
  request: PendingPermissionRequest
}

export const InlinePermissionBar: React.FC<InlinePermissionBarProps> = ({ request }) => {
  const isSubmitting = useAgentStore(state => state.isSubmittingPermission)
  const permissionError = useAgentStore(state => state.permissionError)
  const respondPermissionRequest = useAgentStore(state => state.respondPermissionRequest)
  const currentSessionId = useChatStore(state => state.currentSessionId)

  const [showDropdown, setShowDropdown] = useState(false)
  const groupRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭下拉菜单
  useEffect(() => {
    if (!showDropdown) return
    const handler = (e: MouseEvent) => {
      if (groupRef.current && !groupRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [showDropdown])

  const isBatch = !!request.commands && request.commands.length > 1
  const allowLabel = isBatch ? `全部允许（${request.commands!.length} 条）` : '允许'

  // 收集本次请求涉及的命令前缀（批量取每条命令的首 token）
  const prefixes = new Set<string>()
  if (request.commands && request.commands.length > 0) {
    for (const cmd of request.commands) {
      const token = cmd.trim().split(/\s+/)[0]
      if (token) prefixes.add(token)
    }
  } else {
    const prefix = extractCommandPrefix(request.toolName, request.args)
    if (prefix) prefixes.add(prefix)
  }
  const prefixArray = Array.from(prefixes)
  const hasPrefix = prefixArray.length > 0
  const commandPrefixText = prefixArray.join(', ')

  /** 创建持久化规则后给出本次决策 */
  const rememberAndRespond = async (scope: 'project' | 'global', behavior: PermissionDecision) => {
    const currentProject = useWorkspaceStore.getState().currentProjectPath
    const commandPrefix = extractCommandPrefix(request.toolName, request.args)

    if (scope === 'project' && !currentProject) {
      scope = 'global'
    }

    try {
      await window.api.invoke(PERMISSION_UPSERT, {
        toolName: request.toolName,
        behavior,
        scope,
        ...(commandPrefix ? { commandPrefix } : {}),
        description: `${scope === 'project' ? '本项目' : '全局'} ${behavior === 'allow' ? '允许' : behavior === 'deny' ? '拒绝' : '询问'} ${request.toolName}${commandPrefix ? ' ' + commandPrefix : ''}`
      })
    } catch (err) {
      console.error('[InlinePermissionBar] 创建持久化规则失败:', err)
    }

    respondPermissionRequest(behavior)
    setShowDropdown(false)
  }

  /** 本会话允许同前缀命令 */
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
      console.error('[InlinePermissionBar] 授权临时白名单失败:', err)
    }
    respondPermissionRequest('allow')
    setShowDropdown(false)
  }

  const toggleDropdown = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowDropdown(prev => !prev)
  }

  return (
    <div className="inline-perm" onClick={e => e.stopPropagation()}>
      {request.reason && (
        <div className={`inline-perm__reason inline-perm__reason--${request.riskLevel}`}>
          {request.reason}
        </div>
      )}

      {permissionError && <div className="inline-perm__error">{permissionError}</div>}

      <div className="inline-perm__actions">
        <button
          type="button"
          className="inline-perm__btn inline-perm__btn--deny"
          onClick={() => respondPermissionRequest('deny')}
          disabled={isSubmitting}
        >
          拒绝
        </button>

        <div className="inline-perm__btn-group" ref={groupRef}>
          <button
            type="button"
            className="inline-perm__btn inline-perm__btn--allow"
            onClick={() => respondPermissionRequest('allow')}
            disabled={isSubmitting}
          >
            {isSubmitting ? '提交中...' : allowLabel}
          </button>
          <button
            type="button"
            className="inline-perm__btn-dropdown-toggle"
            onClick={toggleDropdown}
            disabled={isSubmitting}
            title="更多授权选项"
          >
            <span className="inline-perm__dropdown-arrow">▾</span>
          </button>

          {showDropdown && (
            <div className="inline-perm__dropdown-menu">
              <button type="button" onClick={() => respondPermissionRequest('allow')} title="仅本次允许执行当前命令">
                仅本次允许
              </button>
              {hasPrefix && (
                <button
                  type="button"
                  onClick={rememberSessionAndRespond}
                  title={`本会话内执行以 ${commandPrefixText} 开头的命令均直接放行，无需确认`}
                >
                  本会话允许（{commandPrefixText}）
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
              <div className="inline-perm__dropdown-divider" />
              <button
                type="button"
                className="inline-perm__danger-option"
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
  )
}
