/**
 * SkillCard — 设置页技能列表项
 */
import React from 'react'
import type { SkillSummary } from '../../../shared/skills/types'
import { skillSourceLabel, skillsI18n } from './i18n'
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
        <button
          type="button"
          className="skill-card__name"
          onClick={() => onUse(skill.name)}
          title={skillsI18n.use}
        >
          {skill.name}
        </button>
        <span className={`skill-card__badge skill-card__badge--${skill.source}`}>
          {skillSourceLabel(skill.source)}
        </span>
        {skill.modelInvocable && (
          <label className="skill-card__toggle" title={skillsI18n.toggle}>
            <input
              type="checkbox"
              checked={skill.enabled}
              onChange={e => onToggle(skill.name, e.target.checked)}
            />
            <span>模型</span>
          </label>
        )}
      </div>
      <p className="skill-card__desc">{skill.descriptionZh || skill.description}</p>
      <div className="skill-card__actions">
        <button type="button" className="skill-card__btn" onClick={() => onUse(skill.name)}>
          {skillsI18n.use}
        </button>
        {canDelete && onDelete && (
          <button
            type="button"
            className="skill-card__btn skill-card__btn--danger"
            onClick={() => onDelete(skill.name)}
          >
            {skillsI18n.delete}
          </button>
        )}
      </div>
    </div>
  )
}
