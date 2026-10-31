/**
 * SkillTile — 设置页技能小卡：只展示名称与描述，次要操作收进三点菜单，点击卡片查看详情
 */
import React from 'react'
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu'
import type { SkillSummary } from '../../../shared/skills/types'
import { skillsI18n } from './i18n'
import './SkillTile.css'

export interface SkillTileProps {
  skill: SkillSummary
  onOpen: (skill: SkillSummary) => void
  onUse: (name: string) => void
  onExport: (name: string) => void
  onDelete: (name: string) => void
}

export const SkillTile: React.FC<SkillTileProps> = ({ skill, onOpen, onUse, onExport, onDelete }) => {
  const canDelete = skill.source === 'global' || skill.source === 'project'
  const description = skill.invalid
    ? skill.invalidReason ?? '无法解析该技能'
    : skill.descriptionZh || skill.description

  return (
    <li className="skill-tile glass-tile glass-tile--interactive">
      <button type="button" className="skill-tile__main" onClick={() => onOpen(skill)}>
        <span className="skill-tile__name">{skill.name}</span>
        <span className={`skill-tile__desc${skill.invalid ? ' skill-tile__desc--invalid' : ''}`}>
          {description}
        </span>
      </button>
      <div className="skill-tile__menu">
        <DropdownMenu
          button={{
            label: skillsI18n.menuLabel(skill.name),
            icon: <span className="skill-tile__ellipsis" aria-hidden>⋯</span>,
            variant: 'ghost',
            size: 'sm',
            isIconOnly: true
          }}
        >
          {skill.userInvocable && !skill.invalid && (
            <DropdownMenuItem label={skillsI18n.menuUse} onClick={() => onUse(skill.name)} />
          )}
          <DropdownMenuItem label={skillsI18n.export} onClick={() => onExport(skill.name)} />
          {canDelete && (
            <DropdownMenuItem
              label={skillsI18n.delete}
              style={{ color: 'var(--color-error)' }}
              onClick={() => onDelete(skill.name)}
            />
          )}
        </DropdownMenu>
      </div>
    </li>
  )
}
