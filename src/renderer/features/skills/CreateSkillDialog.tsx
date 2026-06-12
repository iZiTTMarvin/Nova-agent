/**
 * CreateSkillDialog — 创建技能弹窗（Task 7）
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { SkillCreateLocation } from '../../../shared/skills/types'
import { skillsI18n } from './i18n'
import './CreateSkillDialog.css'

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_DESC = 340

export type SkillTemplateId = 'blank' | 'new' | 'onboard'

const BLANK_BODY = `# 新技能

<!-- 在此编写技能正文 -->

## 目标

请描述本技能要帮用户完成什么。

## 步骤

1. 
2. 
`

interface CreateSkillDialogProps {
  open: boolean
  hasProject: boolean
  onClose: () => void
  onCreated: (name: string) => void
}

export const CreateSkillDialog: React.FC<CreateSkillDialogProps> = ({
  open,
  hasProject,
  onClose,
  onCreated
}) => {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState(BLANK_BODY)
  const [template, setTemplate] = useState<SkillTemplateId>('blank')
  const [location, setLocation] = useState<SkillCreateLocation>('global')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nameValid = useMemo(() => SLUG_RE.test(name.trim()), [name])
  const descLen = description.length

  const resetForm = useCallback(() => {
    setName('')
    setDescription('')
    setBody(BLANK_BODY)
    setTemplate('blank')
    setLocation('global')
    setError(null)
  }, [])

  useEffect(() => {
    if (!open) {
      resetForm()
    }
  }, [open, resetForm])

  /** 从内置技能加载模板正文 */
  const applyTemplate = async (id: SkillTemplateId) => {
    setTemplate(id)
    if (id === 'blank') {
      setBody(BLANK_BODY)
      return
    }
    try {
      const [skill, fullBody] = await Promise.all([
        window.nova.skill.get(id),
        window.nova.skill.getBody(id)
      ])
      if (fullBody) {
        setBody(fullBody)
      }
      if (!description && skill?.description) {
        setDescription(skill.description.slice(0, MAX_DESC))
      }
    } catch {
      setError(skillsI18n.createTemplateLoadFailed)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedName = name.trim()
    if (!SLUG_RE.test(trimmedName)) {
      setError(skillsI18n.createNameInvalid)
      return
    }
    if (!description.trim()) {
      setError(skillsI18n.createDescRequired)
      return
    }
    if (location === 'project' && !hasProject) {
      setError(skillsI18n.createNeedProject)
      return
    }

    setSubmitting(true)
    try {
      await window.nova.skill.create({
        name: trimmedName,
        description: description.trim(),
        body,
        location
      })
      await window.nova.skill.reload()
      onCreated(trimmedName)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div className="skill-dialog-overlay" onClick={onClose}>
      <div
        className="skill-dialog"
        role="dialog"
        aria-labelledby="create-skill-title"
        onClick={e => e.stopPropagation()}
      >
        <header className="skill-dialog__header">
          <h3 id="create-skill-title" className="skill-dialog__title">
            {skillsI18n.createTitle}
          </h3>
          <button type="button" className="skill-dialog__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <form className="skill-dialog__form" onSubmit={e => void handleSubmit(e)}>
          <div className="settings-modal__field">
            <label className="settings-modal__label" htmlFor="skill-name">
              {skillsI18n.createNameLabel}
            </label>
            <input
              id="skill-name"
              className={`settings-modal__input ${name && !nameValid ? 'settings-modal__input--error' : ''}`}
              value={name}
              onChange={e => setName(e.target.value.toLowerCase())}
              placeholder="my-skill"
              autoFocus
            />
            <span className="settings-modal__help">{skillsI18n.createNameHint}</span>
            {name && !nameValid && (
              <span className="settings-modal__field-error">{skillsI18n.createNameInvalid}</span>
            )}
          </div>

          <div className="settings-modal__field">
            <label className="settings-modal__label" htmlFor="skill-desc">
              {skillsI18n.createDescLabel}
              <span className="skill-dialog__counter">
                {descLen}/{MAX_DESC}
              </span>
            </label>
            <textarea
              id="skill-desc"
              className="settings-editor skill-dialog__textarea--sm"
              rows={3}
              maxLength={MAX_DESC}
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>

          <div className="settings-modal__field">
            <span className="settings-modal__label">{skillsI18n.createTemplateLabel}</span>
            <div className="skill-dialog__template-row">
              {(['blank', 'new', 'onboard'] as SkillTemplateId[]).map(id => (
                <button
                  key={id}
                  type="button"
                  className={`skill-dialog__template-btn ${template === id ? 'skill-dialog__template-btn--active' : ''}`}
                  onClick={() => void applyTemplate(id)}
                >
                  {skillsI18n.createTemplates[id]}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-modal__field">
            <span className="settings-modal__label">{skillsI18n.createLocationLabel}</span>
            <div className="skill-dialog__template-row">
              <button
                type="button"
                className={`skill-dialog__template-btn ${location === 'global' ? 'skill-dialog__template-btn--active' : ''}`}
                onClick={() => setLocation('global')}
              >
                {skillsI18n.createLocationGlobal}
              </button>
              <button
                type="button"
                className={`skill-dialog__template-btn ${location === 'project' ? 'skill-dialog__template-btn--active' : ''}`}
                onClick={() => setLocation('project')}
                disabled={!hasProject}
                title={!hasProject ? skillsI18n.createNeedProject : undefined}
              >
                {skillsI18n.createLocationProject}
              </button>
            </div>
          </div>

          <div className="settings-modal__field skill-dialog__body-field">
            <label className="settings-modal__label" htmlFor="skill-body">
              {skillsI18n.createBodyLabel}
            </label>
            <textarea
              id="skill-body"
              className="settings-editor"
              rows={10}
              value={body}
              onChange={e => setBody(e.target.value)}
            />
          </div>

          {error && <p className="settings-modal__error">{error}</p>}

          <div className="settings-modal__actions">
            <button
              type="button"
              className="settings-modal__btn settings-modal__btn--cancel"
              onClick={onClose}
              disabled={submitting}
            >
              {skillsI18n.createCancel}
            </button>
            <button
              type="submit"
              className="settings-modal__btn settings-modal__btn--save"
              disabled={submitting || !nameValid || !description.trim()}
            >
              {submitting ? skillsI18n.createSubmitting : skillsI18n.createSubmit}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
