/**
 * SkillDetailDialog — 技能详情小弹窗：先看完整描述，指令正文按需展开时才读取
 */
import React, { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Dialog } from '@astryxdesign/core/Dialog'
import { IconButton } from '@astryxdesign/core/IconButton'
import { CloseIcon } from '../../components/Icons'
import type { SkillCatalogDiagnostic, SkillSummary } from '../../../shared/skills/types'
import { skillSourceLabel, skillsI18n } from './i18n'
import './SkillDetailDialog.css'

interface SkillDetailDialogProps {
  skill: SkillSummary
  diagnostics?: SkillCatalogDiagnostic[]
  onClose: () => void
  onUse: (name: string) => void
}

export const SkillDetailDialog: React.FC<SkillDetailDialogProps> = ({ skill, diagnostics, onClose, onUse }) => {
  const [body, setBody] = useState<string | null>(null)
  const description = skill.descriptionZh || skill.description

  const loadBody = (open: boolean) => {
    if (!open || body !== null) return
    setBody(skillsI18n.detailBodyLoading)
    void window.nova.skill
      .getBody(skill.name)
      .then(text => setBody(text ?? ''))
      .catch(err => setBody((err as Error).message))
  }

  return (
    <Dialog
      isOpen
      onOpenChange={open => {
        if (!open) onClose()
      }}
      purpose="info"
      padding={0}
      width="min(520px, 94vw)"
      maxHeight="min(80vh, 640px)"
      className="glass-dialog skill-detail"
      aria-labelledby="skill-detail-title"
    >
      <header className="skill-detail__header">
        <div className="skill-detail__title-block">
          <h3 id="skill-detail-title" className="skill-detail__title">{skill.name}</h3>
          <div className="skill-detail__chips">
            <span className="glass-chip">{skillSourceLabel(skill.source)}</span>
            {skill.userInvocable && !skill.invalid && <span className="glass-chip">/{skill.name}</span>}
          </div>
        </div>
        <IconButton label={skillsI18n.detailClose} icon={<CloseIcon size={16} />} variant="ghost" size="sm" onClick={onClose} />
      </header>

      <div className="skill-detail__body">
        <p className="skill-detail__desc">{skill.invalid ? skill.invalidReason : description}</p>

        {diagnostics && diagnostics.length > 0 && (
          <ul className="skill-detail__notes">
            {diagnostics.map((d, i) => <li key={`${d.code}:${i}`}>{d.message}</li>)}
          </ul>
        )}

        <dl className="skill-detail__meta">
          <dt>{skillsI18n.detailPath}</dt>
          <dd title={skill.sourcePath}>{skill.sourcePath}</dd>
        </dl>

        {!skill.invalid && (
          <details className="skill-detail__fold" onToggle={event => loadBody(event.currentTarget.open)}>
            <summary>{skillsI18n.detailBody}</summary>
            <pre className="skill-detail__pre">{body}</pre>
          </details>
        )}
      </div>

      {skill.userInvocable && !skill.invalid && (
        <footer className="skill-detail__footer">
          <Button
            label={skillsI18n.use}
            variant="primary"
            size="sm"
            onClick={() => {
              onUse(skill.name)
              onClose()
            }}
          />
        </footer>
      )}
    </Dialog>
  )
}
