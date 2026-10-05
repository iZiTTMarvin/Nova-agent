/**
 * Rules 配置面板 — 列表 + textarea 编辑器
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { ClickableCard } from '@astryxdesign/core/ClickableCard'
import { Dialog } from '@astryxdesign/core/Dialog'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { rulesI18n } from '../skills/i18n'
import type { RuleFileEntry } from '../../../shared/settings/types'
import type { RuleScope } from '../../../shared/settings/types'

function validateRuleName(rawName: string): string | null {
  const name = rawName.trim()
  if (!name) return '请输入规则文件名。'
  if (name.length > 80) return '规则文件名不能超过 80 个字符。'
  if (name.toLowerCase().endsWith('.md')) return '请输入不含 .md 扩展名的文件名。'
  if (name === '.' || name === '..' || /[<>:"/\\|?*\u0000-\u001f]/u.test(name)) {
    return '文件名不能包含路径分隔符或 Windows 保留字符。'
  }
  if (name.endsWith('.') || name.endsWith(' ')) return '文件名不能以句点或空格结尾。'
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name)) {
    return '文件名只能以字母或数字开头，并使用字母、数字、下划线或短横线。'
  }
  return null
}

export const RulesSettingsPanel: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const [rules, setRules] = useState<RuleFileEntry[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createScope, setCreateScope] = useState<RuleScope>('global')
  const [createSubmitting, setCreateSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const selected = rules.find(r => r.id === selectedId) ?? null

  const loadRules = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.invoke('rules:list', { workspaceRoot: currentProject })
      setRules(list)
      if (list.length > 0 && !list.some(r => r.id === selectedId)) {
        setSelectedId(list[0].id)
      }
    } finally {
      setLoading(false)
    }
  }, [currentProject, selectedId])

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  useEffect(() => {
    if (!selected) {
      setContent('')
      return
    }
    let cancelled = false
    void window.api
      .invoke('rules:read', { absolutePath: selected.absolutePath, workspaceRoot: currentProject })
      .then(text => {
        if (!cancelled) setContent(text)
      })
      .catch(() => {
        if (!cancelled) setContent('')
      })
    return () => {
      cancelled = true
    }
  }, [selected, currentProject])

  const handleSave = async () => {
    if (!selected) return
    setSaving(true)
    setStatus(null)
    try {
      await window.api.invoke('rules:write', {
        absolutePath: selected.absolutePath,
        content,
        workspaceRoot: currentProject
      })
      setStatus(rulesI18n.saved)
      setTimeout(() => setStatus(null), 2000)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const openCreateDialog = () => {
    setCreateName('')
    setCreateScope(currentProject ? 'workspace' : 'global')
    setCreateError(null)
    setCreateOpen(true)
  }

  const handleCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = createName.trim()
    const nameError = validateRuleName(name)
    if (nameError) {
      setCreateError(nameError)
      return
    }
    if (createScope === 'workspace' && !currentProject) {
      setCreateError(rulesI18n.needProject)
      return
    }
    const targetFileName = `${name}.md`.toLowerCase()
    const duplicate = rules.some(rule => {
      const relativeName = rule.relativePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase()
      return rule.scope === createScope && relativeName === targetFileName
    })
    if (duplicate) {
      setCreateError('相同位置已存在该规则文件。')
      return
    }

    setCreateSubmitting(true)
    setCreateError(null)
    try {
      const created = await window.api.invoke('rules:create', {
        name,
        scope: createScope,
        workspaceRoot: currentProject,
        content: `# ${name}\n\n`
      })
      await loadRules()
      setSelectedId(created.id)
      setCreateOpen(false)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setCreateSubmitting(false)
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-split">
        <aside className="settings-split__list">
          <div className="settings-split__header">
            <span className="settings-split__header-title">
              规则文件
              {!loading && <span className="settings-split__count">{rules.length}</span>}
            </span>
            <Button label={rulesI18n.create} variant="secondary" size="sm" onClick={openCreateDialog}>
              {rulesI18n.create}
            </Button>
          </div>
          {loading && <p className="settings-panel__muted">加载中…</p>}
          {!loading && rules.length === 0 && (
            <p className="settings-panel__muted">{rulesI18n.empty}</p>
          )}
          {rules.map(rule => (
            <ClickableCard
              key={rule.id}
              label={rule.relativePath}
              variant="transparent"
              padding={0}
              width="100%"
              className={`settings-split__item${selectedId === rule.id ? ' settings-split__item--active' : ''}`}
              onClick={() => setSelectedId(rule.id)}
            >
              <span className="settings-split__item-title">{rule.relativePath}</span>
              <span className="settings-split__item-meta">
                {rule.scope === 'workspace' ? rulesI18n.scopeWorkspace : rulesI18n.scopeGlobal}
              </span>
            </ClickableCard>
          ))}
        </aside>

        <div className="settings-split__editor">
          {selected ? (
            <>
              <div className="settings-editor__head">
                <span className="settings-editor__path" title={selected.absolutePath}>{selected.relativePath}</span>
                <span className="settings-split__count">
                  {selected.scope === 'workspace' ? rulesI18n.scopeWorkspace : rulesI18n.scopeGlobal}
                </span>
              </div>
              <TextArea
                label="规则文件内容"
                isLabelHidden
                className="settings-editor"
                value={content}
                onChange={value => setContent(value)}
                hasSpellCheck={false}
                width="100%"
              />
              <div className="settings-editor__footer">
                {status && <span className="settings-panel__status">{status}</span>}
                <Button
                  label={saving ? '保存中…' : rulesI18n.save}
                  variant="primary"
                  size="sm"
                  onClick={handleSave}
                  isDisabled={saving}
                >
                  {saving ? '保存中…' : rulesI18n.save}
                </Button>
              </div>
            </>
          ) : (
            <p className="settings-panel__muted settings-panel__muted--center">{rulesI18n.selectHint}</p>
          )}
        </div>
      </div>
      {createOpen && (
        <Dialog
          isOpen
          purpose="form"
          width="min(520px, calc(100vw - 32px))"
          className="rules-create-dialog"
          aria-labelledby="rules-create-dialog-title"
          onOpenChange={open => {
            if (!open && !createSubmitting) setCreateOpen(false)
          }}
        >
          <form className="rules-create-dialog__form" onSubmit={event => void handleCreate(event)}>
            <h3 id="rules-create-dialog-title">新建规则文件</h3>
            <TextInput
              label="文件名"
              value={createName}
              onChange={value => {
                setCreateName(value)
                if (createError) setCreateError(null)
              }}
              placeholder="例如 project-guidelines"
              description="只需填写文件名，系统会自动添加 .md。"
              hasAutoFocus
              status={createError ? { type: 'error', message: createError } : undefined}
              isDisabled={createSubmitting}
            />
            <div className="rules-create-dialog__scope">
              <span className="rules-create-dialog__label">保存位置</span>
              <div className="rules-create-dialog__scope-options" role="group" aria-label="保存位置">
                <Button
                  type="button"
                  label={rulesI18n.scopeGlobal}
                  variant={createScope === 'global' ? 'primary' : 'secondary'}
                  size="sm"
                  aria-pressed={createScope === 'global'}
                  onClick={() => setCreateScope('global')}
                  isDisabled={createSubmitting}
                >
                  {rulesI18n.scopeGlobal}
                </Button>
                <Button
                  type="button"
                  label={rulesI18n.scopeWorkspace}
                  variant={createScope === 'workspace' ? 'primary' : 'secondary'}
                  size="sm"
                  aria-pressed={createScope === 'workspace'}
                  onClick={() => setCreateScope('workspace')}
                  isDisabled={createSubmitting || !currentProject}
                  tooltip={!currentProject ? rulesI18n.needProject : undefined}
                >
                  {rulesI18n.scopeWorkspace}
                </Button>
              </div>
              <p className="rules-create-dialog__scope-hint">
                {createScope === 'workspace'
                  ? currentProject ?? rulesI18n.needProject
                  : '对所有工作区生效'}
              </p>
            </div>
            <div className="rules-create-dialog__actions">
              <Button
                type="button"
                label="取消"
                variant="ghost"
                size="sm"
                onClick={() => setCreateOpen(false)}
                isDisabled={createSubmitting}
              >
                取消
              </Button>
              <Button
                type="submit"
                label={createSubmitting ? '创建中…' : '创建'}
                variant="primary"
                size="sm"
                isDisabled={createSubmitting}
                isLoading={createSubmitting}
              >
                {createSubmitting ? '创建中…' : '创建'}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  )
}
