/**
 * SkillCard — 设置页技能列表项
 */
import React from 'react'
import type { SkillSummary } from '../../../shared/skills/types'
import { skillSourceLabel, skillsI18n } from './i18n'
import { Button } from '@astryxdesign/core/Button'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import './SkillCard.css'

export interface SkillCardProps {
  skill: SkillSummary
  onToggle: (name: string, enabled: boolean) => void
  onUse: (name: string) => void
  onDelete?: (name: string) => void
}

export const SkillCard: React.FC<SkillCardProps> = ({
  skill,
  onToggle,
  onUse,
  onDelete
}) => {
  const canDelete = skill.source === 'global' || skill.source === 'project'

  return (
    <div className="skill-card">
      <div className="skill-card__main">
        <Button
          label={skill.name}
          variant="ghost"
          size="sm"
          className="skill-card__name"
          onClick={() => onUse(skill.name)}
        />
        <span className={`skill-card__badge skill-card__badge--${skill.source}`}>
          {skillSourceLabel(skill.source)}
        </span>
        {skill.modelInvocable && (
          <span className="skill-card__toggle" title={skillsI18n.toggle}>
            <CheckboxInput
              label="模型"
              value={skill.enabled}
              onChange={checked => onToggle(skill.name, checked)}
              size="sm"
            />
          </span>
        )}
      </div>
      <p className="skill-card__desc">{skill.descriptionZh || skill.description}</p>
      <div className="skill-card__actions">
        <Button
          label={skillsI18n.use}
          variant="secondary"
          size="sm"
          onClick={() => onUse(skill.name)}
        />
        {canDelete && onDelete && (
          <Button
            label={skillsI18n.delete}
            variant="destructive"
            size="sm"
            onClick={() => onDelete(skill.name)}
          />
        )}
      </div>
    </div>
  )
}
