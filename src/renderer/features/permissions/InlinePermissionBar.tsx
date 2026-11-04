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
import type { PermissionBehavior } from '../../../shared/permissions/types'
import type { PendingPermissionRequest } from '../../stores/types'
import { PERMISSION_GRANT_SESSION_PATH, PERMISSION_GRANT_SESSION_SCOPE, PERMISSION_UPSERT } from '../../../shared/ipc/channels'
import './InlinePermissionBar.css'

/**
 * InlinePermissionBar — 内联放行条，渲染在消息流中对应工具卡片附近。
 *
 * 自身展示本次要授权的命令与工作区外路径：所在卡片的命令可能处于折叠区，
 * 用户必须在按钮旁看到「到底在批准什么」。
 * 下拉粒度：仅本次 / 本会话 / 本项目永久 / 全局永久 / 始终拒绝。
 */

/** 超过该条数时折叠其余项，避免批量请求撑高消息流 */
const COLLAPSED_ITEM_LIMIT = 3

/**
 * 从权限请求中提取用于规则匹配的命令前缀。
 * bash 读取 command，shell_session write 读取 input；两者都取首个 token。
 */
function extractCommandPrefix(toolName: string, args: Record<string, unknown>): string | undefined {
  const rawCommand = toolName === 'bash'
    ? args.command
    : toolName === 'shell_session' && args.action === 'write'
      ? args.input
      : undefined
  const command = typeof rawCommand === 'string' ? rawCommand.trim() : ''
  if (!command) return undefined
  const firstToken = command.split(/\s+/)[0]
  return firstToken || undefined
}

/** 本次待授权的完整命令：批量取 commands，单条取 bash command / shell_session 输入 */
function resolveRequestCommands(request: PendingPermissionRequest): string[] {
  if (request.commands && request.commands.length > 0) return request.commands
  const raw = request.toolName === 'bash'
    ? request.args.command
    : request.toolName === 'shell_session' && request.args.action === 'write'
      ? request.args.input
      : undefined
  return typeof raw === 'string' && raw.trim() ? [raw] : []
}

interface CollapsibleListProps {
  items: readonly string[]
  label: string
  className: string
  renderItem: (item: string) => React.ReactNode
}

/** 超过 COLLAPSED_ITEM_LIMIT 条时只显示前几条，其余由按钮展开 */
const CollapsibleList: React.FC<CollapsibleListProps> = ({ items, label, className, renderItem }) => {
  const [expanded, setExpanded] = useState(false)
  const hiddenCount = items.length - COLLAPSED_ITEM_LIMIT
  const visible = expanded || hiddenCount <= 0 ? items : items.slice(0, COLLAPSED_ITEM_LIMIT)
  return (
    <div className={className}>
      <ul className="inline-perm__list" aria-label={label}>
        {visible.map((item, index) => (
          <li key={`${index}:${item}`} className="inline-perm__list-item">
            {renderItem(item)}
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="inline-perm__expand"
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? '收起' : `展开其余 ${hiddenCount} 条`}
        </button>
      )}
    </div>
  )
}

export interface InlinePermissionBarProps {
  request: PendingPermissionRequest
}

export const InlinePermissionBar: React.FC<InlinePermissionBarProps> = ({ request }) => {
  const isSubmitting = useAgentStore(state => state.isSubmittingPermission)
  const permissionError = useAgentStore(state => state.permissionError)
  const respondPermissionRequest = useAgentStore(state => state.respondPermissionRequest)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const grantSessionId = request.sessionId ?? currentSessionId

  const [showDropdown, setShowDropdown] = useState(false)

  const isPathRequest = !!request.externalPaths && request.externalPaths.length > 0
  const pathAccessLabel = request.pathAccess === 'write' ? '写入' : '读取'
  const externalPaths = request.externalPaths ?? []
  const pathGrantLabel = externalPaths.length > 1
    ? `本会话允许这些目录（${externalPaths.length} 个）`
    : '本会话允许此目录'
  const requestCommands = resolveRequestCommands(request)
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

  /**
   * 规则写入失败时提示并中止放行：继续放行会让用户误以为建立了永久/会话级规则，
   * 下次同样命令还会再问一次，属「以为已授权」的错误预期。失败即给出可见错误并保留弹条。
   */
  const failRuleWrite = (label: string, err: unknown): void => {
    console.error(`[InlinePermissionBar] ${label}失败:`, err)
    useAgentStore.setState({ permissionError: `${label}失败，本次未放行，请重试` })
    setShowDropdown(false)
  }

  /** 创建持久化规则后给出本次决策 */
  const rememberAndRespond = async (scope: 'project' | 'global', behavior: PermissionBehavior) => {
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
        description: `${scope === 'project' ? '本项目' : '全局'} ${behavior === 'allow' ? '允许' : '拒绝'} ${request.toolName}${commandPrefix ? ' ' + commandPrefix : ''}`
      })
    } catch (err) {
      failRuleWrite('保存持久化规则', err)
      return
    }

    respondPermissionRequest(behavior)
    setShowDropdown(false)
  }

  /** 本会话允许同前缀命令 */
  const rememberSessionAndRespond = async () => {
    if (!grantSessionId) return
    try {
      for (const prefix of prefixArray) {
        await window.api.invoke(PERMISSION_GRANT_SESSION_SCOPE, {
          sessionId: grantSessionId,
          commandPrefix: prefix
        })
      }
    } catch (err) {
      failRuleWrite('写入本会话白名单', err)
      return
    }
    respondPermissionRequest('allow')
    setShowDropdown(false)
  }

  /**
   * 目录授权覆盖请求里的全部路径：主进程按 requestId 校验每条路径都属于该请求，
   * 只授权首条会让其余路径在放行后继续被拦截或被误以为已授权。
   */
  const rememberPathDirectoryAndRespond = async () => {
    if (!grantSessionId || externalPaths.length === 0) return
    try {
      for (const canonicalPath of externalPaths) {
        await window.api.invoke(PERMISSION_GRANT_SESSION_PATH, {
          sessionId: grantSessionId,
          requestId: request.requestId,
          canonicalPath,
          access: request.pathAccess ?? 'read'
        })
      }
    } catch (err) {
      failRuleWrite('写入本会话目录授权', err)
      return
    }
    respondPermissionRequest('allow')
  }

  return (
    <div className="inline-perm" onClick={e => e.stopPropagation()}>
      {(isPathRequest || request.reason) && (
        <div className={`inline-perm__reason inline-perm__reason--${request.riskLevel}`}>
          {isPathRequest ? '需要访问工作区外文件' : request.reason}
        </div>
      )}
      {requestCommands.length > 0 && (
        <CollapsibleList
          items={requestCommands}
          label="本次授权命令"
          className="inline-perm__commands"
          renderItem={command => <code className="inline-perm__command">{command}</code>}
        />
      )}
      {isPathRequest && (
        <CollapsibleList
          items={externalPaths}
          label={`需要${pathAccessLabel}的工作区外路径`}
          className="inline-perm__paths"
          renderItem={path => (
            <span className="inline-perm__path">
              <code title={path}>{path}</code>
              <span className="inline-perm__path-access">{pathAccessLabel}</span>
            </span>
          )}
        />
      )}

      {permissionError && <div className="inline-perm__error" role="alert">{permissionError}</div>}
      {/* 拒绝后果是决策信息，但只作一行安静提示，不与风险原因形成两块同款色块 */}
      <p className="inline-perm__hint">拒绝后任务会暂停，等待你的下一步指令</p>

      {isPathRequest ? (
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
          <Button
            label="允许一次"
            variant="primary"
            size="sm"
            className="inline-perm__btn inline-perm__btn--allow"
            onClick={() => respondPermissionRequest('allow')}
            isDisabled={isSubmitting}
          >
            {isSubmitting ? '提交中...' : '允许一次'}
          </Button>
          <Button
            label={pathGrantLabel}
            variant="secondary"
            size="sm"
            className="inline-perm__btn"
            onClick={() => void rememberPathDirectoryAndRespond()}
            isDisabled={isSubmitting || !grantSessionId}
          >
            {pathGrantLabel}
          </Button>
        </div>
      ) : (
      <div className="inline-perm__actions">
        {request.riskLevel === 'high' ? (
          <ButtonGroup label="拒绝方式" className="inline-perm__btn-group" size="sm">
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
            <DropdownMenu
              className="inline-perm__dropdown"
              placement="above"
              menuWidth={230}
              isMenuOpen={showDropdown}
              onOpenChange={setShowDropdown}
              button={{
                label: '更多拒绝选项',
                variant: 'secondary',
                size: 'sm',
                isIconOnly: true,
                isDisabled: isSubmitting,
                icon: <span aria-hidden="true">▾</span>,
                tooltip: '更多拒绝选项',
                className: 'inline-perm__btn-dropdown-toggle'
              }}
            >
              <DropdownMenuItem
                label="始终拒绝执行"
                description="创建全局拒绝规则"
                className="inline-perm__danger-option"
                onClick={() => void rememberAndRespond('global', 'deny')}
              />
            </DropdownMenu>
          </ButtonGroup>
        ) : (
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
        )}

        {request.riskLevel === 'high' ? (
          <Button
            label={isBatch ? allowLabel : '允许一次'}
            variant="primary"
            size="sm"
            className="inline-perm__btn inline-perm__btn--allow"
            onClick={() => respondPermissionRequest('allow')}
            isDisabled={isSubmitting}
          >
            {isSubmitting ? '提交中...' : isBatch ? allowLabel : '允许一次'}
          </Button>
        ) : (
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
                isDisabled={!grantSessionId}
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
        )}
      </div>
      )}
    </div>
  )
}
