import React, { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup'
import {
  DropdownMenu,
  DropdownMenuItem
} from '@astryxdesign/core/DropdownMenu'
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

  return (
    <div className="inline-perm" onClick={e => e.stopPropagation()}>
      {request.reason && (
        <div className={`inline-perm__reason inline-perm__reason--${request.riskLevel}`}>
          {request.reason}
        </div>
      )}

      {permissionError && <div className="inline-perm__error">{permissionError}</div>}

      <div className="inline-perm__actions">
        <Button
          label="拒绝"
          variant="secondary"
          size="sm"
          className="inline-perm__btn inline-perm__btn--deny"
          onClick={() => respondPermissionRequest('deny')}
          isDisabled={isSubmitting}
        >
          拒绝
        </Button>

        <ButtonGroup label="权限决策" className="inline-perm__btn-group" size="sm">
          <Button
            label={allowLabel}
            variant="primary"
            size="sm"
            className="inline-perm__btn inline-perm__btn--allow"
            onClick={() => respondPermissionRequest('allow')}
            isDisabled={isSubmitting}
          >
            {isSubmitting ? '提交中...' : allowLabel}
          </Button>
          <DropdownMenu
            className="inline-perm__dropdown"
            placement="above"
            menuWidth={230}
            isMenuOpen={showDropdown}
            onOpenChange={setShowDropdown}
            button={{
              label: '更多授权选项',
              variant: 'primary',
              size: 'sm',
              isIconOnly: true,
              isDisabled: isSubmitting,
              icon: <span aria-hidden="true">▾</span>,
              tooltip: '更多授权选项',
              className: 'inline-perm__btn-dropdown-toggle'
            }}
          >
            <DropdownMenuItem
              label="仅本次允许"
              description="仅允许当前命令执行一次"
              onClick={() => respondPermissionRequest('allow')}
            />
            {hasPrefix && (
              <DropdownMenuItem
                label={`本会话允许（${commandPrefixText}）`}
                description="本会话内相同命令前缀无需再次确认"
                isDisabled={!currentSessionId}
                onClick={() => void rememberSessionAndRespond()}
              />
            )}
            <DropdownMenuItem
              label="本项目永久允许"
              description="创建项目级允许规则"
              onClick={() => void rememberAndRespond('project', 'allow')}
            />
            <DropdownMenuItem
              label="全局永久允许"
              description="创建全局允许规则"
              onClick={() => void rememberAndRespond('global', 'allow')}
            />
            <div role="separator" className="inline-perm__dropdown-divider" />
            <DropdownMenuItem
              label="始终拒绝执行"
              description="创建全局拒绝规则"
              className="inline-perm__danger-option"
              onClick={() => void rememberAndRespond('global', 'deny')}
            />
          </DropdownMenu>
        </ButtonGroup>
      </div>
    </div>
  )
}
