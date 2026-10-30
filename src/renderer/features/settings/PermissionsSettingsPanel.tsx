/**
 * PermissionsSettingsPanel — 权限规则管理面板
 *
 * 列出当前项目的项目级规则 + 全局规则，支持：
 * - 查看规则详情（工具名、行为、匹配条件、范围）
 * - 删除单条规则
 * - 新增规则（简易表单）
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import {
  SettingsCard,
  SettingsCardRow,
  SettingsGlassPanel,
  SettingsPage,
  SettingsSelect
} from './settingsKit'
import type {
  PermissionBehavior,
  PermissionRuleDto,
  PermissionUpsertParams
} from '../../../shared/permissions/types'

type BehaviorLabel = '允许' | '拒绝'
const BEHAVIOR_LABEL: Record<PermissionBehavior, BehaviorLabel> = {
  allow: '允许',
  deny: '拒绝'
}

function ruleDescription(rule: PermissionRuleDto): string | undefined {
  const parts: string[] = []
  if (rule.commandPrefix) parts.push(`前缀：${rule.commandPrefix}`)
  if (rule.commandRegex) parts.push(`正则：${rule.commandRegex}`)
  if (rule.filePath) parts.push(`路径：${rule.filePath}`)
  if (rule.description && !rule.description.includes(rule.toolName)) {
    parts.push(rule.description)
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export const PermissionsSettingsPanel: React.FC = () => {
  const [rules, setRules] = useState<PermissionRuleDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 新增规则表单
  const [toolName, setToolName] = useState('bash')
  const [behavior, setBehavior] = useState<PermissionBehavior>('allow')
  const [scope, setScope] = useState<'global' | 'project'>('project')
  const [commandPrefix, setCommandPrefix] = useState('')
  const [adding, setAdding] = useState(false)

  const loadRules = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await window.api.invoke('permission:list', {})
      setRules(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载权限规则失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  const handleAdd = async () => {
    setAdding(true)
    setError(null)
    try {
      const params: PermissionUpsertParams = {
        toolName: toolName.trim() || '*',
        behavior,
        scope
      }
      if (commandPrefix.trim()) {
        params.commandPrefix = commandPrefix.trim()
      }
      params.description = `${scope === 'project' ? '本项目' : '全局'} ${BEHAVIOR_LABEL[behavior]} ${toolName}${commandPrefix ? ' ' + commandPrefix : ''}`
      await window.api.invoke('permission:upsert', params)
      setCommandPrefix('')
      await loadRules()
    } catch (err) {
      setError(err instanceof Error ? err.message : '新增规则失败')
    } finally {
      setAdding(false)
    }
  }

  const handleDelete = async (ruleId: string) => {
    try {
      await window.api.invoke('permission:delete', { ruleId })
      await loadRules()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除规则失败')
    }
  }

  return (
    <SettingsGlassPanel className="permissions-settings-panel">
      <div className="settings-panel__scroll">
        <SettingsPage>
          <SettingsCard
            title="新增规则"
            description="为工具执行配置默认规则。项目级规则优先于全局设定。"
          >
            <div className="perm-rule-form">
              <SettingsSelect
                label="工具"
                isLabelHidden
                options={[
                  { value: 'bash', label: 'bash' },
                  { value: 'write', label: 'write' },
                  { value: 'edit', label: 'edit' },
                  { value: '*', label: '所有工具 (*)' }
                ]}
                value={toolName}
                onChange={value => setToolName(value)}
                width={120}
                isDisabled={adding}
              />
              <SettingsSelect
                label="行为"
                isLabelHidden
                options={[
                  { value: 'allow', label: '允许' },
                  { value: 'deny', label: '拒绝' }
                ]}
                value={behavior}
                onChange={value => setBehavior(value as PermissionBehavior)}
                width={100}
                isDisabled={adding}
              />
              <SettingsSelect
                label="范围"
                isLabelHidden
                options={[
                  { value: 'project', label: '本项目' },
                  { value: 'global', label: '全局' }
                ]}
                value={scope}
                onChange={value => setScope(value as 'global' | 'project')}
                width={110}
                isDisabled={adding}
              />
              <TextInput
                label="命令前缀"
                isLabelHidden
                value={commandPrefix}
                onChange={value => setCommandPrefix(value)}
                placeholder="命令前缀（可选，如 npm install）"
                isDisabled={adding}
              />
              <Button
                label={adding ? '添加中…' : '添加'}
                variant="primary"
                size="sm"
                onClick={() => void handleAdd()}
                isDisabled={adding}
              >
                {adding ? '添加中…' : '添加'}
              </Button>
            </div>
          </SettingsCard>

          <SettingsCard
            title={`当前生效规则（${rules.length} 条）`}
            description="在操作授权提示中选择「始终允许」也会自动沉淀为持久化规则。"
            aside={
              <Button
                label={loading ? '刷新中…' : '刷新'}
                variant="ghost"
                size="sm"
                onClick={() => void loadRules()}
                isDisabled={loading}
              >
                {loading ? '刷新中…' : '刷新'}
              </Button>
            }
          >
            {loading && (
              <span className="settings-help">加载中…</span>
            )}
            {!loading && rules.length === 0 && (
              <span className="settings-help">
                暂无权限规则。在授权弹窗中选择「始终允许」或通过上方直接添加。
              </span>
            )}
            {!loading &&
              rules.map(rule => (
                <SettingsCardRow
                  key={rule.id}
                  label={
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span className={`glass-chip ${rule.behavior === 'allow' ? 'glass-chip--success' : 'glass-chip--danger'}`}>
                        {BEHAVIOR_LABEL[rule.behavior]}
                      </span>
                      <code style={{ fontSize: '0.86rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {rule.toolName}
                      </code>
                      <span className="glass-chip">{rule.scope === 'project' ? '项目' : '全局'}</span>
                    </div>
                  }
                  description={ruleDescription(rule)}
                  control={
                    <Button
                      label="删除"
                      variant="ghost"
                      size="sm"
                      className="perm-rule__delete"
                      onClick={() => void handleDelete(rule.id)}
                    >
                      删除
                    </Button>
                  }
                />
              ))}
          </SettingsCard>

          {error && (
            <div className="settings-status settings-status--gap settings-status--error">{error}</div>
          )}
        </SettingsPage>
      </div>
    </SettingsGlassPanel>
  )
}
