/**
 * Rules 配置面板 — 全局 / 项目分段，文件标签 + 整幅编辑器
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Dialog } from '@astryxdesign/core/Dialog'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { listWorkspaceProjects, workspaceLabel } from '../composer-context/workspaceDisplay'
import { rulesI18n } from '../skills/i18n'
import { confirmDialog } from '../confirm/confirmDialog'
import { SettingsGlassPanel, SettingsSegmented, SettingsSelect } from './settingsKit'
import type { RuleFileEntry, RuleScope } from '../../../shared/settings/types'
import './RulesSettingsPanel.css'

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

function fileLabel(rule: RuleFileEntry): string {
  return rule.relativePath.replace(/\\/g, '/').split('/').pop() ?? rule.relativePath
}

export const RulesSettingsPanel: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const availableSessions = useWorkspaceStore(state => state.availableSessions)
  const defaultWorkspacePath = useWorkspaceStore(state => state.defaultWorkspacePath)
  const [projectChoice, setProjectChoice] = useState<string | null>(null)
  const [rules, setRules] = useState<RuleFileEntry[]>([])
  const [scopeChoice, setScopeChoice] = useState<RuleScope>(currentProject ? 'workspace' : 'global')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createSubmitting, setCreateSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // 可编辑的项目：当前项目在前，其余来自会话历史（与侧栏、输入框工作区菜单同源）
  const projects = useMemo(() => {
    const paths = listWorkspaceProjects(availableSessions, defaultWorkspacePath).map(project => project.path)
    if (currentProject && !paths.includes(currentProject)) paths.unshift(currentProject)
    return paths
  }, [availableSessions, defaultWorkspacePath, currentProject])
  const projectRoot = projectChoice && projects.includes(projectChoice)
    ? projectChoice
    : currentProject ?? projects[0] ?? null

  // 没有任何项目时，项目范围不可用，自动落在全局
  const scope: RuleScope = scopeChoice === 'workspace' && !projectRoot ? 'global' : scopeChoice
  const visible = useMemo(() => rules.filter(rule => rule.scope === scope), [rules, scope])
  const selected = visible.find(rule => rule.id === selectedId) ?? null
  const dirty = selected !== null && content !== savedContent

  const loadRules = useCallback(async () => {
    setLoading(true)
    try {
      setRules(await window.api.invoke('rules:list', { workspaceRoot: projectRoot }))
    } finally {
      setLoading(false)
    }
  }, [projectRoot])

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  useEffect(() => {
    if (!visible.some(rule => rule.id === selectedId)) setSelectedId(visible[0]?.id ?? null)
  }, [visible, selectedId])

  useEffect(() => {
    if (!selected) {
      setContent('')
      setSavedContent('')
      return
    }
    let cancelled = false
    void window.api
      .invoke('rules:read', { absolutePath: selected.absolutePath, workspaceRoot: projectRoot })
      .then(text => {
        if (cancelled) return
        setContent(text)
        setSavedContent(text)
      })
      .catch(() => {
        if (cancelled) return
        setContent('')
        setSavedContent('')
      })
    return () => {
      cancelled = true
    }
  }, [selected?.id, selected?.absolutePath, projectRoot])

  /** 有未保存修改时切换文件或范围前先确认，避免静默丢稿 */
  const confirmDiscard = async (): Promise<boolean> => {
    if (!dirty) return true
    const choice = await confirmDialog({
      type: 'warning',
      title: '放弃未保存的修改？',
      message: `「${selected ? fileLabel(selected) : ''}」还有未保存的修改。`,
      buttons: ['继续编辑', '放弃修改'],
      defaultId: 0
    })
    return choice === 1
  }

  const selectRule = async (id: string) => {
    if (id === selectedId || !(await confirmDiscard())) return
    setSelectedId(id)
  }

  const selectScope = async (next: RuleScope) => {
    if (next === scope || !(await confirmDiscard())) return
    setScopeChoice(next)
  }

  const handleSave = async () => {
    if (!selected) return
    setSaving(true)
    setStatus(null)
    try {
      await window.api.invoke('rules:write', {
        absolutePath: selected.absolutePath,
        content,
        workspaceRoot: projectRoot
      })
      setSavedContent(content)
      setStatus(rulesI18n.saved)
      setTimeout(() => setStatus(null), 2000)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const openCreateDialog = async () => {
    if (!(await confirmDiscard())) return
    setCreateName('')
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
    const targetFileName = `${name}.md`.toLowerCase()
    if (visible.some(rule => fileLabel(rule).toLowerCase() === targetFileName)) {
      setCreateError('相同位置已存在该规则文件。')
      return
    }

    setCreateSubmitting(true)
    setCreateError(null)
    try {
      const created = await window.api.invoke('rules:create', {
        name,
        scope,
        workspaceRoot: projectRoot,
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

  const selectProjectRoot = async (next: string) => {
    if (next === projectRoot || !(await confirmDiscard())) return
    setProjectChoice(next)
  }

  const scopeHint = scope === 'workspace'
    ? `仅对该项目生效 · ${projectRoot}`
    : '对所有项目生效 · ~/.nova/rules'

  return (
    <SettingsGlassPanel className="rules-panel">
      <div className="rules-body">
        <div className="rules-toolbar">
          <SettingsSegmented
            label="规则范围"
            value={scope}
            onChange={next => void selectScope(next)}
            options={[
              { value: 'global', label: rulesI18n.scopeGlobal },
              {
                value: 'workspace',
                label: rulesI18n.scopeWorkspace,
                isDisabled: !projectRoot,
                title: projectRoot ? undefined : rulesI18n.needProject
              }
            ]}
          />
          {scope === 'workspace' && projectRoot && (
            <div className="rules-project">
              <SettingsSelect
                label="选择项目"
                isLabelHidden
                value={projectRoot}
                options={projects.map(path => ({ value: path, label: workspaceLabel(path, defaultWorkspacePath) }))}
                onChange={value => void selectProjectRoot(value)}
                size="sm"
                width={220}
              />
            </div>
          )}
          <Button label={rulesI18n.create} variant="primary" size="sm" onClick={() => void openCreateDialog()}>
            {rulesI18n.create}
          </Button>
        </div>
        <p className="rules-hint" title={scopeHint}>{scopeHint}</p>

        {visible.length > 0 && (
          <div className="rules-files" role="group" aria-label="规则文件">
            {visible.map(rule => (
              <button
                key={rule.id}
                type="button"
                aria-pressed={rule.id === selectedId}
                title={rule.relativePath}
                className={`rules-file glass-chip${rule.id === selectedId ? ' glass-chip--accent' : ''}`}
                onClick={() => void selectRule(rule.id)}
              >
                {fileLabel(rule)}
              </button>
            ))}
          </div>
        )}

        <section className="rules-editor glass-card" aria-label="规则编辑">
          {selected ? (
            <>
              <div className="rules-editor__head">
                <span className="rules-editor__path" title={selected.absolutePath}>{selected.relativePath}</span>
                {dirty && <span className="glass-chip glass-chip--caution">未保存</span>}
              </div>
              <TextArea
                label="规则文件内容"
                isLabelHidden
                className="settings-editor"
                value={content}
                onChange={setContent}
                hasSpellCheck={false}
                width="100%"
              />
              <div className="rules-editor__footer">
                {status && <span className="settings-panel__status">{status}</span>}
                <Button
                  label={saving ? '保存中…' : rulesI18n.save}
                  variant="primary"
                  size="sm"
                  onClick={() => void handleSave()}
                  isDisabled={saving || !dirty}
                >
                  {saving ? '保存中…' : rulesI18n.save}
                </Button>
              </div>
            </>
          ) : (
            <div className="rules-empty">
              <strong>
                {loading ? '加载中…' : scope === 'workspace' ? '这个项目还没有规则文件' : '还没有全局规则文件'}
              </strong>
              {!loading && <span>{rulesI18n.empty}，点击右上角「新建」开始编写。</span>}
            </div>
          )}
        </section>
      </div>

      {createOpen && (
        <Dialog
          isOpen
          purpose="form"
          width="min(480px, calc(100vw - 32px))"
          className="glass-dialog rules-create-dialog"
          aria-labelledby="rules-create-dialog-title"
          onOpenChange={open => {
            if (!open && !createSubmitting) setCreateOpen(false)
          }}
        >
          <form className="rules-create-dialog__form" onSubmit={event => void handleCreate(event)}>
            <h3 id="rules-create-dialog-title">
              新建{scope === 'workspace' ? '项目' : '全局'}规则
            </h3>
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
    </SettingsGlassPanel>
  )
}
