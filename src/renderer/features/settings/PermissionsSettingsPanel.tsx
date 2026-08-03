/**
 * PermissionsSettingsPanel — 权限规则管理面板（PRD §5.2）
 *
 * 列出当前项目的项目级规则 + 全局规则，支持：
 * - 查看规则详情（工具名、行为、匹配条件、范围）
 * - 删除单条规则
 * - 新增规则（简易表单）
 *
 * 注意：权限规则 ≠ 规则文件（RuleFileEntry）。本面板只管工具调用授权规则。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Selector } from '@astryxdesign/core/Selector'
import { TextInput } from '@astryxdesign/core/TextInput'
import type { PermissionRuleDto, PermissionUpsertParams } from '../../../shared/permissions/types'
import type { PermissionDecision } from '../../../shared/session/types'

type BehaviorLabel = '允许' | '拒绝' | '询问'
const BEHAVIOR_LABEL: Record<PermissionDecision, BehaviorLabel> = {
  allow: '允许',
  deny: '拒绝',
  ask: '询问'
}
const BEHAVIOR_CLASS: Record<PermissionDecision, string> = {
  allow: 'perm-rule__behavior--allow',
  deny: 'perm-rule__behavior--deny',
  ask: 'perm-rule__behavior--ask'
}

export const PermissionsSettingsPanel: React.FC = () => {
  const [rules, setRules] = useState<PermissionRuleDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 新增规则表单
  const [toolName, setToolName] = useState('bash')
  const [behavior, setBehavior] = useState<PermissionDecision>('allow')
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
    <div className="settings-panel">
      <header className="settings-panel__header">
        <h3 className="settings-panel__title">权限</h3>
        <p className="settings-panel__desc">
          管理工具调用的持久化授权规则。项目级规则只对当前打开的项目生效。
          <br />
          注意：与「规则」面板的 agent 行为规则文件不同，这里是工具调用授权规则。
        </p>
      </header>

      <div className="settings-modal__form settings-panel__scroll">
        {/* 新增规则 */}
        <div className="settings-modal__field">
          <label className="settings-modal__label">新增规则</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Selector
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
            >
            </Selector>
            <Selector
              label="行为"
              isLabelHidden
              options={[
                { value: 'allow', label: '允许' },
                { value: 'ask', label: '询问' },
                { value: 'deny', label: '拒绝' }
              ]}
              value={behavior}
              onChange={value => setBehavior(value as PermissionDecision)}
              width={100}
              isDisabled={adding}
            >
            </Selector>
            <Selector
              label="范围"
              isLabelHidden
              options={[
                { value: 'project', label: '本项目' },
                { value: 'global', label: '全局' }
              ]}
              value={scope}
              onChange={value => setScope(value as 'global' | 'project')}
              width={120}
              isDisabled={adding}
            >
            </Selector>
            <TextInput
              label="命令前缀"
              isLabelHidden
              value={commandPrefix}
              onChange={value => setCommandPrefix(value)}
              placeholder="命令前缀（可选，如 npm install）"
              width="100%"
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
          <span className="settings-modal__help">
            匹配优先级：项目级 &gt; 全局；显式工具 &gt; 通配；同级 deny 优先于 allow。
          </span>
        </div>

        {error && <div className="settings-modal__error">{error}</div>}

        {/* 规则列表 */}
        <div className="settings-modal__field">
          <label className="settings-modal__label">
            当前规则（{rules.length} 条）
          </label>
          {loading ? (
            <div className="settings-modal__help">加载中…</div>
          ) : rules.length === 0 ? (
            <div className="settings-modal__help">暂无持久化规则。权限弹窗中选择「始终允许」会自动创建规则。</div>
          ) : (
            <div className="perm-rules-list">
              {rules.map(rule => (
                <div key={rule.id} className="perm-rule">
                  <div className="perm-rule__main">
                    <span className={`perm-rule__behavior ${BEHAVIOR_CLASS[rule.behavior]}`}>
                      {BEHAVIOR_LABEL[rule.behavior]}
                    </span>
                    <span className="perm-rule__tool">{rule.toolName}</span>
                    {rule.commandPrefix && (
                      <span className="perm-rule__matcher">前缀: {rule.commandPrefix}</span>
                    )}
                    {rule.commandRegex && (
                      <span className="perm-rule__matcher">正则: {rule.commandRegex}</span>
                    )}
                    {rule.filePath && (
                      <span className="perm-rule__matcher">文件: {rule.filePath}</span>
                    )}
                  </div>
                  <div className="perm-rule__meta">
                    <span className="perm-rule__scope">
                      {rule.scope === 'project' ? '项目级' : '全局'}
                    </span>
                    {rule.description && <span className="perm-rule__desc">{rule.description}</span>}
                    <Button
                      label="删除"
                      variant="destructive"
                      size="sm"
                      className="perm-rule__delete"
                      onClick={() => void handleDelete(rule.id)}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
