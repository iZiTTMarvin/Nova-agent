/**
 * CreateSkillDialog — 创建技能弹窗（Task 7）
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { SkillCreateLocation } from '../../../shared/skills/types'
import { skillsI18n } from './i18n'
import { Button } from '@astryxdesign/core/Button'
import { Dialog } from '@astryxdesign/core/Dialog'
import { IconButton } from '@astryxdesign/core/IconButton'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { CloseIcon } from '../../components/Icons'
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
    <Dialog
      isOpen={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
      purpose="info"
      padding={0}
      width="min(520px, 96vw)"
      maxHeight="min(88vh, 680px)"
      className="skill-dialog"
      aria-labelledby="create-skill-title"
    >
        <header className="skill-dialog__header">
          <h3 id="create-skill-title" className="skill-dialog__title">
            {skillsI18n.createTitle}
          </h3>
          <IconButton
            label="关闭"
            icon={<CloseIcon size={16} />}
            variant="ghost"
            size="sm"
            className="skill-dialog__close"
            onClick={onClose}
          />
        </header>

        <form className="skill-dialog__form" onSubmit={e => void handleSubmit(e)}>
          <div className="skill-dialog__field">
            <TextInput
              id="skill-name"
              label={skillsI18n.createNameLabel}
              value={name}
              onChange={value => setName(value.toLowerCase())}
              placeholder="my-skill"
              hasAutoFocus
              status={name && !nameValid ? { type: 'error', message: skillsI18n.createNameInvalid } : undefined}
              description={skillsI18n.createNameHint}
            />
          </div>

          <div className="skill-dialog__field">
            <TextArea
              id="skill-desc"
              className="settings-editor skill-dialog__textarea--sm"
              label={skillsI18n.createDescLabel}
              rows={3}
              maxLength={MAX_DESC}
              value={description}
              onChange={value => setDescription(value.slice(0, MAX_DESC))}
            />
          </div>

          <div className="skill-dialog__field">
            <span className="skill-dialog__label">{skillsI18n.createTemplateLabel}</span>
            <div className="skill-dialog__template-row">
              {(['blank', 'new', 'onboard'] as SkillTemplateId[]).map(id => (
                <Button
                  key={id}
                  label={skillsI18n.createTemplates[id]}
                  variant={template === id ? 'primary' : 'secondary'}
                  size="sm"
                  aria-pressed={template === id}
                  type="button"
                  className="skill-dialog__template-btn"
                  onClick={() => void applyTemplate(id)}
                />
              ))}
            </div>
          </div>

          <div className="skill-dialog__field">
            <span className="skill-dialog__label">{skillsI18n.createLocationLabel}</span>
            <div className="skill-dialog__template-row">
              <Button
                label={skillsI18n.createLocationGlobal}
                variant={location === 'global' ? 'primary' : 'secondary'}
                size="sm"
                aria-pressed={location === 'global'}
                type="button"
                className="skill-dialog__template-btn"
                onClick={() => setLocation('global')}
              />
              <Button
                label={skillsI18n.createLocationProject}
                variant={location === 'project' ? 'primary' : 'secondary'}
                size="sm"
                aria-pressed={location === 'project'}
                type="button"
                className="skill-dialog__template-btn"
                onClick={() => setLocation('project')}
                isDisabled={!hasProject}
                tooltip={!hasProject ? skillsI18n.createNeedProject : undefined}
              />
            </div>
          </div>

          <div className="skill-dialog__field skill-dialog__body-field">
            <TextArea
              id="skill-body"
              className="settings-editor"
              label={skillsI18n.createBodyLabel}
              rows={10}
              value={body}
              onChange={value => setBody(value)}
            />
          </div>

          {error && <p className="skill-dialog__error">{error}</p>}

          <div className="skill-dialog__actions">
            <Button
              label={skillsI18n.createCancel}
              variant="ghost"
              size="sm"
              type="button"
              onClick={onClose}
              isDisabled={submitting}
            />
            <Button
              label={submitting ? skillsI18n.createSubmitting : skillsI18n.createSubmit}
              variant="primary"
              size="sm"
              type="submit"
              isDisabled={submitting || !nameValid || !description.trim()}
              isLoading={submitting}
            />
          </div>
        </form>
    </Dialog>
  )
}
